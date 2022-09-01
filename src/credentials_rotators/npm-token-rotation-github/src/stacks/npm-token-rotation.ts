import * as core from "@aws-cdk/core";
import * as lambda from "@aws-cdk/aws-lambda";
import * as lambdaNodeJs from "@aws-cdk/aws-lambda-nodejs";
import * as sfn from "@aws-cdk/aws-stepfunctions";
import * as tasks from "@aws-cdk/aws-stepfunctions-tasks";
import * as path from "path";

import { BaseStack } from "./base-stack";
import { NPMTokenRotationConfig } from "./types";
import { Duration } from "@aws-cdk/core";
import { IFunction } from "@aws-cdk/aws-lambda";

export type NpmTokenRotationStackParams = {
  config: NPMTokenRotationConfig;
};

/**
 * This stack contains the implementation for rotating the token.
 * 
 * See README.md for high level overview.
 */
export class NpmTokenRotationStack extends BaseStack {
  private secretConfig: NPMTokenRotationConfig;

  constructor(
    scope: core.Construct,
    id: string,
    options: NpmTokenRotationStackParams
  ) {
    super(scope, id);
    this.secretConfig = options.config;

    // create lambda function objects

    /**
     * This is the head lambda function that Secrets Managers use to 
     * rotate its secrets on cron.
     * 
     * https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_how.html
     */
    const rotatorFn = new lambdaNodeJs.NodejsFunction(this, "lambda", {
      entry: path.normalize(
        path.join(__dirname, "..", "lambda", "create-new-token", "index.ts")
      ),
    });

    // Rotator function starts the following step functions.

    /**
     * Step function 1: Publish new token to CCI
     */
    const tokenPublisherFn = new lambdaNodeJs.NodejsFunction(
      this,
      "step-fn-token-publisher",
      {
        entry: path.normalize(
          path.join(
            __dirname,
            "..",
            "lambda",
            "step-01-publish-token",
            "index.ts"
          )
        ),
      }
    );

    /**
     * Step function 2: Remove old NPM token
     */
    const tokenRemovalFn = new lambdaNodeJs.NodejsFunction(
      this,
      "step-fn-delete-token",
      {
        entry: path.normalize(
          path.join(
            __dirname,
            "..",
            "lambda",
            "step-02-delete-old-token",
            "index.ts"
          )
        ),
      }
    );

    const deleteOldTokenStateMachine = this.buildTokenDeletionStateMachine(
      core.Duration.minutes(15),
      tokenPublisherFn,
      tokenRemovalFn
    );

    this.addEnvironment(
      "DELETE_TOKEN_STATE_MACHINE_ARN",
      deleteOldTokenStateMachine.stateMachineArn,
      [rotatorFn]
    );

    /**
     * Grant proper iam accesses
     */
    this.grantSecretsManagerToAccessLambda(rotatorFn);

    this.grantLambdaFunctionToAccessStepFunctions(
      rotatorFn,
      deleteOldTokenStateMachine
    );

    /**
     * Grant lambdas to access NPM credentials
     */
    this.grantLambdaAccessToSecrets(rotatorFn, [
      this.secretConfig.npmLoginUsernameSecret,
      this.secretConfig.npmLoginPasswordSecret,
      this.secretConfig.npmOtpSeedSecret,
    ]);
    this.grantLambdaAccessToSecrets(tokenRemovalFn, [
      this.secretConfig.npmLoginUsernameSecret,
      this.secretConfig.npmLoginPasswordSecret,
      this.secretConfig.npmOtpSeedSecret,
    ]);

    /**
     * Grant lambdas access to npm token in secrets manager, and GitHub
     * Bot User Credentials.
     */
    for (const token of this.secretConfig.npmAccessTokenSecrets.secrets) {
      this.grantLambdaAccessToRotateSecrets(rotatorFn, token);
      this.grantLambdaAccessToSecrets(tokenRemovalFn, [
        token,
        ...(token.slackWebHookConfig ? [token.slackWebHookConfig] : []),
      ]);
      this.grantLambdaAccessToSecrets(tokenPublisherFn, [
        token,
        token.publishConfig.githubToken,
        ...(token.slackWebHookConfig ? [token.slackWebHookConfig] : []),
      ]);
      this.configureSecretRotation(rotatorFn, token, Duration.days(7));
    }

    this.enableCloudWatchAlarmNotification(
      rotatorFn,
      "npm_access_token_secrets",
      this.secretConfig.npmAccessTokenSecrets
    );
    this.enableCloudWatchAlarmNotification(
      tokenPublisherFn,
      "token_publisher",
      this.secretConfig.npmAccessTokenSecrets
    );
    this.enableCloudWatchAlarmNotification(
      tokenPublisherFn,
      "token_remover",
      this.secretConfig.npmAccessTokenSecrets
    );
  }


  /**
   * Create the state machine for step functions
   */
  private buildTokenDeletionStateMachine = (
    wait: core.Duration,
    publishFn: IFunction,
    deleteFn: IFunction
  ): sfn.StateMachine => {
    wait.formatTokenToNumber();
    const steps = new tasks.LambdaInvoke(this, "publish-new-token", {
      lambdaFunction: publishFn,
      payloadResponseOnly: true,
    })
      .next(
        new sfn.Wait(
          this,
          `Wait ${wait.toHumanString()} before invalidating NPM Access Token`,
          { time: sfn.WaitTime.duration(wait) }
        )
      )
      .next(
        new tasks.LambdaInvoke(this, "invalidate-old-token", {
          lambdaFunction: deleteFn,
          payloadResponseOnly: true,
          timeout: wait.plus(Duration.minutes(1)),
        })
      );

    return new sfn.StateMachine(this, "token-invalidation-step-fn", {
      definition: steps,
    });
  };

  private addEnvironment = (
    name: string,
    value: string,
    fns: lambda.Function[]
  ) => {
    for (const fn of fns) {
      fn.addEnvironment(name, value);
    }
  };
}
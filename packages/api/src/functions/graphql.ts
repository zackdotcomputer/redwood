/* eslint-disable react-hooks/rules-of-hooks */
import { useApolloTracing } from '@envelop/apollo-tracing'
import { envelop, useErrorHandler, useSchema, Plugin } from '@envelop/core'
import type {
  APIGatewayProxyEvent,
  Context as LambdaContext,
  APIGatewayProxyResult,
} from 'aws-lambda'
import {
  GraphQLError,
  GraphQLSchema,
  NoSchemaIntrospectionCustomRule,
} from 'graphql'
import { Request, getGraphQLParameters, processRequest } from 'graphql-helix'

import type { AuthContextPayload } from 'src/auth'
import { getAuthenticationContext } from 'src/auth'
import {
  getPerRequestContext,
  setContext,
  usePerRequestContext,
} from 'src/globalContext'

export type GetCurrentUser = (
  decoded: AuthContextPayload[0],
  raw: AuthContextPayload[1],
  req?: AuthContextPayload[2]
) => Promise<null | Record<string, unknown> | string>

export type Context = Record<string, unknown>
export type ContextFunction = (...args: any[]) => Context | Promise<Context>
export type RedwoodGraphQLContext = {
  event: APIGatewayProxyEvent
  // TODO: Maybe this needs a better name?
  context: LambdaContext
}

interface GraphQLHandlerOptions {
  /**
   * Modify the resolver and global context.
   */
  context?: Context | ContextFunction
  /**
   * An async function that maps the auth token retrieved from the request headers to an object.
   * Is it executed when the `auth-provider` contains one of the supported providers.
   */
  getCurrentUser?: GetCurrentUser
  /**
   * A callback when an unhandled exception occurs. Use this to disconnect your prisma instance.
   */
  onException?: () => void
  /**
   * The GraphQL Schema
   */
  schema: GraphQLSchema

  // TODO: Support this of course
  // cors?: CreateHandlerOptions['cors']
  // onHealthCheck?: CreateHandlerOptions['onHealthCheck']
}

function normalizeRequest(event: APIGatewayProxyEvent): Request {
  return {
    headers: event.headers || {},
    method: event.httpMethod,
    query: event.queryStringParameters,
    body: event.body,
  }
}

function redwoodErrorHandler(errors: Readonly<GraphQLError[]>) {
  for (const error of errors) {
    // I want the dev-server to pick this up!?
    // TODO: Move the error handling into a separate package
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    import('@redwoodjs/dev-server/dist/error')
      .then(({ handleError }) => {
        return handleError(error.originalError as Error)
      })
      .then(console.log)
      .catch(() => {})
  }
}

/**
 * Envelop plugin for injecting the current user into the GraphQL Context,
 * based on custom getCurrentUser function.
 */
const useAuthContext = (
  getCurrentUser: GraphQLHandlerOptions['getCurrentUser']
): Plugin<RedwoodGraphQLContext> => {
  return {
    async onContextBuilding({ context, extendContext }) {
      const lambdaContext = context.context as any

      const authContext = await getAuthenticationContext({
        event: context.event,
        context: lambdaContext,
      })

      if (authContext) {
        const currentUser = getCurrentUser
          ? await getCurrentUser(authContext[0], authContext[1], authContext[2])
          : authContext

        lambdaContext.currentUser = currentUser
      }

      // TODO: Maybe we don't need to spread the entire object here? since it's already there
      extendContext(lambdaContext)
    },
  }
}

const useUserContext = (
  userContextBuilder: NonNullable<GraphQLHandlerOptions['context']>
): Plugin<RedwoodGraphQLContext> => {
  return {
    async onContextBuilding({ context, extendContext }) {
      const userContext =
        typeof userContextBuilder === 'function'
          ? await userContextBuilder(context)
          : userContextBuilder

      extendContext(userContext)
    },
  }
}

/**
 * This Envelop plugin waits until the GraphQL context is done building and sets the
 * Redwood global context which can be imported with:
 * // import { context } from '@redwoodjs/api'
 * @returns
 */
const useRedwoodGlobalContextSetter = (): Plugin<RedwoodGraphQLContext> => ({
  onContextBuilding() {
    return ({ context }) => {
      setContext(context)
    }
  },
})

/**
 * Creates an Apollo GraphQL Server.
 *
 * ```js
 * export const handler = createGraphQLHandler({ schema, context, getCurrentUser })
 * ```
 */
export const createGraphQLHandler = ({
  schema,
  context,
  getCurrentUser,
  onException,
}: // TODO: Handle CORS and health check endpoints, should be easy enough
// cors,
// onHealthCheck,
GraphQLHandlerOptions) => {
  const plugins: Plugin<any>[] = [
    useSchema(schema),
    useAuthContext(getCurrentUser),
    useRedwoodGlobalContextSetter(),
  ]

  if (context) {
    plugins.push(useUserContext(context))
  }

  const isDevEnv = process.env.NODE_ENV === 'development'
  if (isDevEnv) {
    plugins.push(useApolloTracing())
    plugins.push(useErrorHandler(redwoodErrorHandler))
  }

  const getEnvlopedFn = envelop({ plugins })

  const handlerFn = async (
    event: APIGatewayProxyEvent,
    lambdaContext: LambdaContext
  ): Promise<APIGatewayProxyResult> => {
    lambdaContext.callbackWaitsForEmptyEventLoop = false

    // In the future, the normalizeRequest can take more flexible params, maybe evne cloud provider name
    // and return a normalized request structure.
    const request = normalizeRequest(event)
    const enveloped = getEnvlopedFn()
    const { operationName, query, variables } = getGraphQLParameters(request)

    try {
      const result = await processRequest({
        operationName,
        query,
        variables,
        request,
        validationRules: isDevEnv
          ? undefined
          : [NoSchemaIntrospectionCustomRule],
        ...enveloped,
        contextFactory: () =>
          enveloped.contextFactory({ event, context: lambdaContext }),
      })

      if (result.type === 'RESPONSE') {
        return {
          body: JSON.stringify(result.payload),
          statusCode: 200,
          headers: (result.headers || {}).reduce(
            (prev, header) => ({ ...prev, [header.name]: header.value }),
            {}
          ),
        }
      } else if (result.type === 'MULTIPART_RESPONSE') {
        return {
          body: JSON.stringify({ error: 'Streaming is not supported yet!' }),
          statusCode: 500,
        }
      } else if (result.type === 'PUSH') {
        return {
          body: JSON.stringify({
            error: 'Subscriptions is not supported yet!',
          }),
          statusCode: 500,
        }
      }

      return {
        body: JSON.stringify({ error: 'Unexpected flow' }),
        statusCode: 500,
      }
    } catch (e) {
      onException && onException()

      return {
        body: JSON.stringify({ error: 'GraphQL execution failed' }),
        statusCode: 500,
      }
    }
  }

  return (event: APIGatewayProxyEvent, context: LambdaContext): void => {
    if (usePerRequestContext()) {
      // This must be used when you're self-hosting RedwoodJS.
      const localAsyncStorage = getPerRequestContext()
      localAsyncStorage.run(new Map(), () => {
        try {
          handlerFn(event, context)
        } catch (e) {
          onException && onException()
          throw e
        }
      })
    } else {
      // This is OK for AWS (Netlify/Vercel) because each Lambda request
      // is handled individually.
      try {
        handlerFn(event, context)
      } catch (e) {
        onException && onException()
        throw e
      }
    }
  }
}

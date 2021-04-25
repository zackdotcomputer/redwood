import { APIGatewayProxyEventV1OrV2 } from 'apollo-server-lambda/dist/ApolloServer'
import { Request } from 'graphql-helix'

import { CorsContext } from './cors'

const HEALTH_CHECK_PATH = '/.well-known/apollo/server-health'

export type OnHealthcheckFn = (
  event: APIGatewayProxyEventV1OrV2
) => Promise<any>

export function createHealthcheckContext(
  onHealthcheckFn?: OnHealthcheckFn,
  corsContext?: CorsContext
) {
  return {
    isHealthcheckRequest(requestPath: string) {
      return requestPath.endsWith(HEALTH_CHECK_PATH)
    },
    async handleHealthCheck(
      request: Request,
      event: APIGatewayProxyEventV1OrV2
    ) {
      const corsHeaders = corsContext
        ? corsContext.getRequestHeaders(request)
        : {}

      if (onHealthcheckFn) {
        try {
          await onHealthcheckFn(event)
        } catch (_) {
          return {
            body: JSON.stringify({ status: 'fail' }),
            statusCode: 503,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders,
            },
          }
        }
      }

      return {
        body: JSON.stringify({ status: 'pass' }),
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    },
  }
}

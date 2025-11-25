import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;

// Structured Logger
const logger = {
  info: (message: string, data?: any) => console.log(JSON.stringify({ level: 'INFO', message, ...data })),
  error: (message: string, error?: any) => console.error(JSON.stringify({ level: 'ERROR', message, error: error?.message || error, stack: error?.stack })),
  warn: (message: string, data?: any) => console.warn(JSON.stringify({ level: 'WARN', message, ...data })),
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const path = event.path;
  const method = event.httpMethod;
  const pathParameters = event.pathParameters || {};
  const requestId = event.requestContext?.requestId;

  logger.info('Processing request', { path, method, requestId });

  try {
    // Health check
    if (path === '/health' && method === 'GET') {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          service: 'flightpulse-api',
        }),
      };
    }

    // Get flight by ID
    if (path.match(/^\/flights\/[^\/]+$/) && method === 'GET') {
      const flightId = pathParameters.flightId!;
      const result = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: `FLIGHT#${flightId}`,
            SK: 'METADATA',
          },
        })
      );

      if (!result.Item) {
        logger.warn('Flight not found', { flightId });
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: 'Flight not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flight_id: result.Item.flight_id,
          origin: result.Item.origin,
          destination: result.Item.destination,
          scheduled_departure: result.Item.scheduled_departure,
          scheduled_arrival: result.Item.scheduled_arrival,
          status: result.Item.status,
          gate: result.Item.gate,
          delay_minutes: result.Item.delay_minutes || 0,
          delay_reason: result.Item.delay_reason,
        }),
      };
    }

    // Get flights by status
    if (path === '/flights' && method === 'GET') {
      const status = event.queryStringParameters?.status;
      if (!status) {
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: 'status query parameter required' }),
        };
      }

      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :status',
          ExpressionAttributeValues: {
            ':status': status,
          },
        })
      );

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flights: result.Items || [],
          count: result.Count || 0,
        }),
      };
    }

    // Get flight bookings
    if (path.match(/^\/flights\/[^\/]+\/bookings$/) && method === 'GET') {
      const flightId = pathParameters.flightId!;
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: {
            ':pk': `FLIGHT#${flightId}`,
            ':sk': 'BOOKING#',
          },
        })
      );

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookings: result.Items?.map(item => ({
            booking_id: item.booking_id,
            passenger_id: item.passenger_id,
          })) || [],
          count: result.Count || 0,
        }),
      };
    }

    // Get passenger by ID
    if (path.match(/^\/passengers\/[^\/]+$/) && method === 'GET') {
      const passengerId = pathParameters.passengerId!;
      const result = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: `PASSENGER#${passengerId}`,
            SK: 'METADATA',
          },
        })
      );

      if (!result.Item) {
        logger.warn('Passenger not found', { passengerId });
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: 'Passenger not found' }),
        };
      }

      const { email, phone, ...safeData } = result.Item;
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(safeData),
      };
    }

    // Get passenger bookings
    if (path.match(/^\/passengers\/[^\/]+\/bookings$/) && method === 'GET') {
      const passengerId = pathParameters.passengerId!;
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: {
            ':pk': `PASSENGER#${passengerId}`,
            ':sk': 'BOOKING#',
          },
        })
      );

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookings: result.Items?.map(item => ({
            booking_id: item.booking_id,
            flight_id: item.flight_id,
          })) || [],
          count: result.Count || 0,
        }),
      };
    }

    // Get booking by ID
    if (path.match(/^\/bookings\/[^\/]+$/) && method === 'GET') {
      const bookingId = pathParameters.bookingId!;
      const result = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: `BOOKING#${bookingId}`,
            SK: 'METADATA',
          },
        })
      );

      if (!result.Item) {
        logger.warn('Booking not found', { bookingId });
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: 'Booking not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(result.Item),
      };
    }

    logger.warn('Route not found', { path, method });
    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error: any) {
    logger.error('Internal Server Error', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: error.message }),
    };
  }
};


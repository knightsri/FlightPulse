import { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const eventBridge = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

// Structured Logger
const logger = {
  info: (message: string, data?: any) => console.log(JSON.stringify({ level: 'INFO', message, ...data })),
  error: (message: string, error?: any) => console.error(JSON.stringify({ level: 'ERROR', message, error: error?.message || error, stack: error?.stack })),
  warn: (message: string, data?: any) => console.warn(JSON.stringify({ level: 'WARN', message, ...data })),
};

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  logger.info('Processing stream records', { count: event.Records.length });

  for (const record of event.Records) {
    try {
      if (record.eventName === 'MODIFY' || record.eventName === 'INSERT') {
        const newImage = record.dynamodb?.NewImage;
        const oldImage = record.dynamodb?.OldImage;

        if (!newImage) continue;

        const pk = newImage.PK?.S || '';
        const sk = newImage.SK?.S || '';

        // Detect booking status changes
        if (pk.startsWith('BOOKING#') && sk === 'METADATA') {
          const newStatus = newImage.booking_status?.S;
          const oldStatus = oldImage?.booking_status?.S;

          if (newStatus && newStatus !== oldStatus) {
            logger.info('Booking status changed', { bookingId: pk.replace('BOOKING#', ''), oldStatus, newStatus });

            await eventBridge.send(
              new PutEventsCommand({
                Entries: [
                  {
                    EventBusName: EVENT_BUS_NAME,
                    Source: 'flightpulse.stream-handler',
                    DetailType: 'booking.status_changed',
                    Detail: JSON.stringify({
                      booking_id: pk.replace('BOOKING#', ''),
                      old_status: oldStatus,
                      new_status: newStatus,
                      timestamp: new Date().toISOString(),
                    }),
                  },
                ],
              })
            );
          }
        }
      }
    } catch (error: any) {
      logger.error('Error processing record', { record, error });
      // Continue processing other records
    }
  }
};


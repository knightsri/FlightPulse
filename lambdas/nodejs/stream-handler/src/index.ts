import { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const eventBridge = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
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
  }
};


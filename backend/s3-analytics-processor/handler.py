"""
S3 Post-Call Analytics Processor Lambda

Triggered by S3 events when Contact Lens writes post-call analysis files.
Parses the analysis JSON and writes transcription records to DynamoDB
in the same schema as the real-time transcription processor.
"""

import json
import os
import urllib.parse
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict

import boto3
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

logger = Logger()
tracer = Tracer()
metrics = Metrics()

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

TRANSCRIPTIONS_TABLE = os.environ.get('TRANSCRIPTIONS_TABLE', 'sca-transcriptions')
table = dynamodb.Table(TRANSCRIPTIONS_TABLE)

PARTICIPANT_MAP = {
    'SYSTEM': 'AGENT',
    'AGENT': 'AGENT',
    'BOT': 'AGENT',
    'CUSTOMER': 'CUSTOMER',
}


def convert_floats_to_decimal(obj: Any) -> Any:
    if isinstance(obj, float):
        return Decimal(str(obj))
    elif isinstance(obj, dict):
        return {k: convert_floats_to_decimal(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_floats_to_decimal(item) for item in obj]
    return obj


@tracer.capture_lambda_handler
@logger.inject_lambda_context
@metrics.log_metrics
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    results = []

    for record in event.get('Records', []):
        bucket = record['s3']['bucket']['name']
        key = urllib.parse.unquote_plus(record['s3']['object']['key'])

        # Only process analysis JSON files
        if not key.startswith('Analysis/') or not key.endswith('.json'):
            logger.info(f"Skipping non-analysis file: {key}")
            continue

        logger.info(f"Processing analysis file: s3://{bucket}/{key}")

        obj = s3.get_object(Bucket=bucket, Key=key)
        analysis = json.loads(obj['Body'].read().decode('utf-8'))

        contact_id = analysis.get('CustomerMetadata', {}).get('ContactId', '')
        channel = analysis.get('Channel', 'VOICE')
        language = analysis.get('LanguageCode', 'en-US')
        transcripts = analysis.get('Transcript', [])

        # Build a ParticipantId -> ParticipantRole lookup from the Participants array.
        # Segment entries reference participants by UUID (ParticipantId), so we must
        # resolve the role (CUSTOMER / AGENT / SYSTEM / BOT) before mapping to speaker.
        participant_roles = {
            p.get('ParticipantId'): p.get('ParticipantRole')
            for p in analysis.get('Participants', [])
            if p.get('ParticipantId')
        }

        if not contact_id:
            logger.warning(f"No ContactId in analysis file: {key}")
            continue

        stored_count = 0
        now = datetime.utcnow().isoformat()

        with table.batch_writer() as batch:
            for idx, segment in enumerate(transcripts):
                content = segment.get('Content', '').strip()
                if not content:
                    continue

                # Segments reference the participant by ID; resolve to a role first.
                participant_id = segment.get('ParticipantId', '')
                role = participant_roles.get(participant_id) or segment.get('ParticipantRole') or 'CUSTOMER'
                speaker = PARTICIPANT_MAP.get(str(role).upper(), 'CUSTOMER')
                begin_ms = segment.get('BeginOffsetMillis', 0)
                end_ms = segment.get('EndOffsetMillis', 0)
                segment_id = segment.get('Id', f'segment-{idx}')

                # Build a timestamp from the contact ID timestamp in the key + offset
                timestamp = datetime.utcnow().isoformat() + 'Z'

                pk = contact_id
                sk = f"{timestamp}#{idx:010d}"

                item = convert_floats_to_decimal({
                    'PK': pk,
                    'SK': sk,
                    'contactId': contact_id,
                    'sequenceNumber': idx,
                    'timestamp': timestamp,
                    'speaker': speaker,
                    'text': content,
                    'confidence': 1.0,
                    'createdAt': now,
                    'updatedAt': now,
                    'metadata': {
                        'segmentId': segment_id,
                        'segmentType': 'Transcript',
                        'channel': channel,
                        'language': language,
                        'beginOffsetMillis': begin_ms,
                        'endOffsetMillis': end_ms,
                        'sentiment': segment.get('Sentiment', {}).get('OverallSentiment', 'NEUTRAL') if isinstance(segment.get('Sentiment'), dict) else 'NEUTRAL',
                        'contactStatus': 'COMPLETED',
                        'source': 's3-post-call',
                    },
                    'GSI1PK': f'CONTACT#{contact_id}',
                    'GSI1SK': f'SEQ#{idx:010d}',
                })

                batch.put_item(Item=item)
                stored_count += 1

        # Write a completion marker
        table.put_item(Item=convert_floats_to_decimal({
            'PK': contact_id,
            'SK': 'STATUS',
            'contactId': contact_id,
            'status': 'COMPLETED',
            'totalSegments': stored_count,
            'source': 's3-post-call',
            'createdAt': now,
            'updatedAt': now,
            'GSI1PK': f'CONTACT#{contact_id}',
            'GSI1SK': 'STATUS',
        }))

        logger.info(f"Stored {stored_count} transcription segments for contact {contact_id}")
        metrics.add_metric(name="SegmentsStored", unit=MetricUnit.Count, value=stored_count)
        metrics.add_metric(name="ContactsProcessed", unit=MetricUnit.Count, value=1)

        results.append({
            'contactId': contact_id,
            'segmentsStored': stored_count,
        })

    return {'results': results}

"""
Analytics Processor Lambda Function with Durable Execution

This Lambda function processes DynamoDB Stream events from the Transcriptions table,
implements skip logic to ensure all transcriptions are received, and triggers analytics
processing when contacts are complete. Uses Lambda Durable Functions for resilient Bedrock processing.
"""

import json
import os
from datetime import datetime
from typing import Dict, List, Any

import boto3
from aws_lambda_powertools import Logger, Metrics
from aws_lambda_powertools.metrics import MetricUnit
from botocore.exceptions import ClientError
from aws_durable_execution_sdk_python import durable_execution, DurableContext, durable_step, StepContext

from bedrock_analytics import BedrockAnalytics, convert_floats_to_decimal

# Initialize AWS Lambda Powertools
logger = Logger()
metrics = Metrics(namespace="AnalyticsProcessor")

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')

# Environment variables
TRANSCRIPTIONS_TABLE = os.environ.get('TRANSCRIPTIONS_TABLE', 'sca-transcriptions')
ANALYTICS_TABLE = os.environ.get('ANALYTICS_TABLE', 'sca-analytics')

# Initialize DynamoDB tables
transcriptions_table = dynamodb.Table(TRANSCRIPTIONS_TABLE)
analytics_table = dynamodb.Table(ANALYTICS_TABLE)

# Initialize Bedrock analytics
bedrock_analytics = BedrockAnalytics()


@durable_step
def get_all_transcriptions(step_ctx: StepContext, contact_id: str) -> List[Dict[str, Any]]:
    """
    Retrieve all transcriptions for a contact, applying the same deduplication 
    and filtering logic as the data retrieval API to ensure consistency
    """
    response = transcriptions_table.query(
        KeyConditionExpression='PK = :pk',
        ExpressionAttributeValues={':pk': contact_id},
        ScanIndexForward=True
    )
    
    # Get all items (including STATUS records initially)
    all_items = response.get('Items', [])
    
    # Filter out STATUS records (keep only transcription records that start with timestamp)
    raw_transcriptions = [
        item for item in all_items
        if item.get('SK', '').startswith('2')
    ]
    
    # Apply the SAME deduplication logic as data-retrieval API
    # Group by timestamp and text content, keep the one with highest sequence number
    transcription_groups = {}
    for trans in raw_transcriptions:
        # Create a unique key based on timestamp and text (the actual content)
        key = f"{trans.get('timestamp', '')}_{trans.get('text', '')}"
        seq_num = trans.get('sequenceNumber', 0)
        
        # Keep the transcription with the highest sequence number for this content
        if key not in transcription_groups or seq_num > transcription_groups[key].get('sequenceNumber', 0):
            transcription_groups[key] = trans
    
    # Convert back to list
    deduplicated_transcriptions = list(transcription_groups.values())
    
    # Apply the SAME validation logic as the frontend to ensure consistency
    # Filter out invalid transcriptions that won't be displayed
    valid_transcriptions = []
    for item in deduplicated_transcriptions:
        # Skip if missing text or timestamp
        if not item.get('text') or not item.get('timestamp'):
            continue
        
        # Skip if timestamp is invalid
        try:
            from datetime import datetime
            datetime.fromisoformat(item['timestamp'].replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            continue
        
        # Skip if confidence is 0 (likely invalid data)
        if item.get('confidence', 1.0) == 0:
            continue
        
        valid_transcriptions.append(item)
    
    logger.info(
        f"Retrieved {len(all_items)} items for contact {contact_id}, "
        f"{len(raw_transcriptions)} transcription records, "
        f"deduplicated to {len(deduplicated_transcriptions)}, "
        f"filtered to {len(valid_transcriptions)} valid transcriptions"
    )
    
    return valid_transcriptions


@durable_step
def analyze_sentiment_step(step_ctx: StepContext, transcriptions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Step: Analyze sentiment using Bedrock"""
    logger.info("Analyzing sentiment")
    return bedrock_analytics.analyze_sentiment(transcriptions)


@durable_step
def extract_topics_step(step_ctx: StepContext, transcriptions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Step: Extract topics using Bedrock"""
    logger.info("Extracting topics")
    return bedrock_analytics.extract_topics(transcriptions)


@durable_step
def generate_summary_step(step_ctx: StepContext, transcriptions: List[Dict[str, Any]]) -> str:
    """Step: Generate summary using Bedrock"""
    logger.info("Generating summary")
    summary_chunks = []
    for chunk in bedrock_analytics.generate_summary_streaming(transcriptions):
        summary_chunks.append(chunk)
    return ''.join(summary_chunks)


@durable_step
def store_analytics(step_ctx: StepContext, contact_id: str, analytics: Dict[str, Any]) -> None:
    """Store analytics results in DynamoDB"""
    logger.info(f"Storing analytics for contact {contact_id}")
    
    # Store sentiment (if available)
    if 'sentiment' in analytics:
        sentiment_item = {
            'PK': contact_id,
            'SK': 'ANALYTICS#SENTIMENT',
            'contactId': contact_id,
            'analyticsType': 'SENTIMENT',
            'content': json.dumps(analytics['sentiment']),
            'confidence': analytics['sentiment'].get('confidence'),
            'generatedAt': analytics['generatedAt'],
            'metadata': {
                'overall': analytics['sentiment']['overall'],
                'segmentCount': len(analytics['sentiment'].get('segments', []))
            }
        }
        sentiment_item = convert_floats_to_decimal(sentiment_item)
        analytics_table.put_item(Item=sentiment_item)
    
    # Store topics (if available)
    if 'topics' in analytics:
        topics_item = {
            'PK': contact_id,
            'SK': 'ANALYTICS#TOPICS',
            'contactId': contact_id,
            'analyticsType': 'TOPICS',
            'content': json.dumps(analytics['topics']),
            'generatedAt': analytics['generatedAt'],
            'metadata': {
                'topicCount': len(analytics['topics'])
            }
        }
        topics_item = convert_floats_to_decimal(topics_item)
        analytics_table.put_item(Item=topics_item)
    
    # Store summary
    summary_item = {
        'PK': contact_id,
        'SK': 'ANALYTICS#SUMMARY',
        'contactId': contact_id,
        'analyticsType': 'SUMMARY',
        'content': analytics['summary'],
        'generatedAt': analytics['generatedAt'],
        'metadata': {
            'summaryLength': len(analytics['summary'])
        }
    }
    summary_item = convert_floats_to_decimal(summary_item)
    analytics_table.put_item(Item=summary_item)
    
    logger.info(f"Analytics stored successfully for contact {contact_id}")


@durable_execution
def lambda_handler(event: Dict[str, Any], context: DurableContext) -> Dict[str, Any]:
    """
    Lambda handler with durable execution for analytics processing.
    Triggered by DynamoDB Stream events from the Transcriptions table.
    """
    logger.info("Processing analytics with durable execution")
    
    records = event.get('Records', [])
    logger.info(f"Processing {len(records)} DynamoDB Stream records")
    
    processed_contacts = []
    
    for record in records:
        if record['eventName'] in ['INSERT', 'MODIFY']:
            new_image = record['dynamodb'].get('NewImage', {})
            sk = new_image.get('SK', {}).get('S', '')
            
            if sk == 'STATUS':
                status = new_image.get('status', {}).get('S', '')
                contact_id = new_image.get('contactId', {}).get('S', '')
                
                if status == 'COMPLETED' and contact_id:
                    logger.info(f"Contact {contact_id} completed, processing analytics")
                    
                    # Get transcriptions (checkpointed)
                    transcriptions = context.step(
                        get_all_transcriptions(contact_id),
                        name=f'get_transcriptions_{contact_id}'
                    )
                    
                    if not transcriptions:
                        logger.warning(f"No transcriptions found for contact {contact_id}")
                        continue
                    
                    # Analyze sentiment (checkpointed - will retry on throttling)
                    sentiment = context.step(
                        analyze_sentiment_step(transcriptions),
                        name=f'analyze_sentiment_{contact_id}'
                    )
                    
                    # Extract topics (checkpointed - will retry on throttling)
                    topics = context.step(
                        extract_topics_step(transcriptions),
                        name=f'extract_topics_{contact_id}'
                    )
                    
                    # Generate summary (checkpointed - will retry on throttling)
                    summary = context.step(
                        generate_summary_step(transcriptions),
                        name=f'generate_summary_{contact_id}'
                    )
                    
                    # Store analytics (checkpointed)
                    analytics = {
                        'contactId': contact_id,
                        'sentiment': sentiment,
                        'topics': topics,
                        'summary': summary,
                        'generatedAt': datetime.utcnow().isoformat()
                    }
                    
                    context.step(
                        store_analytics(contact_id, analytics),
                        name=f'store_analytics_{contact_id}'
                    )
                    
                    processed_contacts.append(contact_id)
                    metrics.add_metric(name="AnalyticsCompleted", unit=MetricUnit.Count, value=1)
                    logger.info(f"Analytics completed for contact {contact_id}")
    
    return {
        'statusCode': 200,
        'body': {
            'totalRecords': len(records),
            'processedContacts': len(processed_contacts)
        }
    }

#!/bin/bash
# Ingest sample transcription segments into the SCA Kinesis Data Stream
# Usage: ./scripts/ingest-transcriptions.sh [contact-id]
#
# Simulates a healthcare insurance call where the InTakeAgent collects
# caller information for eligibility determination.
#
# The stream name is retrieved dynamically from the ScaBackendStack CloudFormation outputs.
# A contact ID can be provided as an argument, otherwise a random one is generated.

set -euo pipefail

# Retrieve stream name from CDK stack output
STREAM_NAME=$(aws cloudformation describe-stacks \
  --stack-name ScaBackendStack \
  --query "Stacks[0].Outputs[?OutputKey=='TranscriptionStreamName'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$STREAM_NAME" ] || [ "$STREAM_NAME" = "None" ]; then
  echo "Error: Could not retrieve Kinesis stream name from ScaBackendStack."
  echo "Make sure the stack is deployed: cdk deploy ScaBackendStack"
  exit 1
fi

echo "Using Kinesis stream: $STREAM_NAME"

# Generate or use provided contact ID
CONTACT_ID="${1:-contact-$(date +%s)-$(( RANDOM % 1000 ))}"
BASE_EPOCH=$(date +%s)

echo "Contact ID: $CONTACT_ID"
echo ""

# Create a temp file for payloads (avoids shell quoting issues with AWS CLI v1)
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

# Helper: generate an ISO timestamp offset by N seconds from the base time
offset_ts() {
  local offset_secs=$1
  date -u -d "@$(( BASE_EPOCH + offset_secs ))" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null \
    || date -u -r $(( BASE_EPOCH + offset_secs )) +"%Y-%m-%dT%H:%M:%S.000Z"
}

# Helper function to send a JSON payload to Kinesis via temp file
send_segment() {
  local description="$1"
  local payload="$2"

  echo -n "$payload" > "$TMPFILE"
  aws kinesis put-record \
    --stream-name "$STREAM_NAME" \
    --partition-key "$CONTACT_ID" \
    --data "fileb://$TMPFILE" \
    --output text --query 'SequenceNumber' > /dev/null

  echo "  Sent: $description"
}

echo "Sending transcription segments..."

TS1=$(offset_ts 0)
TS2=$(offset_ts 8)
TS3=$(offset_ts 16)
TS4=$(offset_ts 24)
TS5=$(offset_ts 32)
TS6=$(offset_ts 40)
TS7=$(offset_ts 48)
TS8=$(offset_ts 56)
TS9=$(offset_ts 64)
TS10=$(offset_ts 72)

# --- Segment 1: Agent greeting ---
send_segment "Segment 1 - Agent greeting" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "Welcome to Acme Insurance. I will ask you some questions to determine your product eligibility. Could you please provide me with your first and last name?",
        "BeginOffsetMillis": 0,
        "EndOffsetMillis": 7500,
        "Id": "segment-001",
        "Time": {"AbsoluteTime": "'"$TS1"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 2: Customer provides name ---
send_segment "Segment 2 - Customer provides name" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "Hi, my name is Jane Doe.",
        "BeginOffsetMillis": 8000,
        "EndOffsetMillis": 11000,
        "Id": "segment-002",
        "Time": {"AbsoluteTime": "'"$TS2"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 3: Agent asks for DOB ---
send_segment "Segment 3 - Agent asks for DOB" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "Thank you, Jane. And what is your date of birth?",
        "BeginOffsetMillis": 16000,
        "EndOffsetMillis": 19000,
        "Id": "segment-003",
        "Time": {"AbsoluteTime": "'"$TS3"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 4: Customer provides DOB ---
send_segment "Segment 4 - Customer provides DOB" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "March 15th, 1958.",
        "BeginOffsetMillis": 24000,
        "EndOffsetMillis": 26000,
        "Id": "segment-004",
        "Time": {"AbsoluteTime": "'"$TS4"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 5: Agent asks for address and state ---
send_segment "Segment 5 - Agent asks for address" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "Could you tell me your state of residence and residential address?",
        "BeginOffsetMillis": 32000,
        "EndOffsetMillis": 36000,
        "Id": "segment-005",
        "Time": {"AbsoluteTime": "'"$TS5"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 6: Customer provides address ---
send_segment "Segment 6 - Customer provides address" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "I live in California. My address is 123 Main Street, Los Angeles, California 90001.",
        "BeginOffsetMillis": 40000,
        "EndOffsetMillis": 47000,
        "Id": "segment-006",
        "Time": {"AbsoluteTime": "'"$TS6"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 7: Agent asks about Medicare ---
send_segment "Segment 7 - Agent asks about Medicare" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "Are you currently eligible for Medicare?",
        "BeginOffsetMillis": 48000,
        "EndOffsetMillis": 51000,
        "Id": "segment-007",
        "Time": {"AbsoluteTime": "'"$TS7"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 8: Customer confirms Medicare ---
send_segment "Segment 8 - Customer confirms Medicare" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "Yes, I am. I turned 65 last year and I enrolled in Medicare Part A and Part B.",
        "BeginOffsetMillis": 56000,
        "EndOffsetMillis": 62000,
        "Id": "segment-008",
        "Time": {"AbsoluteTime": "'"$TS8"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 9: Agent asks reason for calling ---
send_segment "Segment 9 - Agent asks reason" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "And what is the reason for your call today?",
        "BeginOffsetMillis": 64000,
        "EndOffsetMillis": 67000,
        "Id": "segment-009",
        "Time": {"AbsoluteTime": "'"$TS9"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 10: Customer explains reason ---
send_segment "Segment 10 - Customer explains reason" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "I am looking into Medicare Advantage plans. I want to understand what options are available in my area and whether I would get better coverage than what I have now with original Medicare.",
        "BeginOffsetMillis": 72000,
        "EndOffsetMillis": 82000,
        "Id": "segment-010",
        "Time": {"AbsoluteTime": "'"$TS10"'"},
        "Sentiment": "POSITIVE"
      }
    }
  ]
}'

sleep 1

# --- COMPLETED event ---
send_segment "COMPLETED event" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "COMPLETED"
}'

echo ""
echo "Done! Sent 10 transcription segments + COMPLETED event for contact: $CONTACT_ID"
echo ""
echo "Caller: Jane Doe, DOB: 03/15/1958, State: CA, Medicare: Yes"
echo "Reason: Looking into Medicare Advantage plans"
echo ""
echo "Check the analytics-processor Lambda logs for processing results."

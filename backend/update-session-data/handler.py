import json
import boto3

connect_client = boto3.client('connect')
qconnect_client = boto3.client('qconnect')


def handler(event, context):
    print("Received event:", json.dumps(event))

    contact_data = event['Details']['ContactData']
    contact_id = contact_data['ContactId']
    instance_arn = contact_data['InstanceARN']
    instance_id = instance_arn.split('/')[-1]
    attributes = contact_data.get('Attributes', {})

    contact = connect_client.describe_contact(
        InstanceId=instance_id,
        ContactId=contact_id
    )['Contact']

    wisdom_info = contact.get('WisdomInfo', {})
    session_arn = wisdom_info.get('SessionArn', '')

    if not session_arn:
        print("No session ARN found on contact")
        return {'message': 'Error', 'reason': 'No AI agent session found'}

    print("Session ARN:", session_arn)

    arn_resource = session_arn.split(':')[-1]
    arn_parts = arn_resource.split('/')
    assistant_id = arn_parts[1]
    session_id = arn_parts[2]

    preferred_language = attributes.get('preferredLanguage', '')
    if not preferred_language:
        return {'message': 'Error', 'reason': 'No preferredLanguage attribute found'}

    session_data = [{'key': 'preferredLanguage', 'value': {'stringValue': preferred_language}}]

    qconnect_client.update_session_data(
        assistantId=assistant_id,
        sessionId=session_id,
        data=session_data,
        namespace='Custom'
    )

    print(f"Updated session {session_id} with {len(session_data)} attributes")
    return {'message': 'Success', 'attributesUpdated': str(len(session_data))}

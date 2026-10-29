#!/usr/bin/env python3
"""Write a ZCode Personal Provider via local, hidden input. Never print the key."""
import argparse
import getpass
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--region', choices=['bigmodel', 'zai'], default='bigmodel')
parser.add_argument('--access', choices=['coding-plan', 'api'], default='coding-plan')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
target = args.output.expanduser().absolute()
if target.exists():
    parser.error('Output already exists; choose a new path or use the existing official config')
if not os.isatty(0):
    parser.error('Run this command in your local terminal for hidden key input')
key = getpass.getpass('ZCode API Key (hidden): ').strip()
if not key:
    parser.error('Key cannot be empty')
provider_id = 'personal:uniagent-zcode-' + args.region + ('-standard' if args.access == 'api' else '')
document = {
    'schemaVersion': 1,
    'config': {
        'providerConfigRules': {'providerRules': [{
            'providerId': provider_id,
            'templateId': args.region + ('-standard-api' if args.access == 'api' else '-api'),
            'providerName': 'UniAgent ZCode',
            'enabled': True,
            'config': {
                'group': 'standard-personal',
                'access': {'type': 'api-key' if args.access == 'api' else 'zhipu-coding-plan-api-key', 'apiKey': key},
                'api': {
                    'type': 'openai-chat-completions' if args.access == 'api' else 'anthropic-messages',
                    'baseUrl': ('https://open.bigmodel.cn' if args.region == 'bigmodel' else 'https://api.z.ai') + ('/api/paas/v4' if args.access == 'api' else '/api/anthropic'),
                },
                'personalModelIds': ['GLM-5.3', 'GLM-5.3-Flash'],
            },
        }]},
        'modelConfigRules': {'providerModelRules': [], 'manualProviderModelRules': []},
        'defaultModelSelection': {'providerId': provider_id, 'modelId': 'GLM-5.3'},
    },
}
target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(descriptor, 'w') as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
except BaseException:
    target.unlink(missing_ok=True)
    raise
print('Provider config saved:', target)

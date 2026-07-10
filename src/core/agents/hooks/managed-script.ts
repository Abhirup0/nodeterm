// Generates the managed hook script installed into an agent's own config.
// It sources the endpoint file for the LIVE port/token (restart handoff), no-ops
// outside nodeterm-spawned sessions (gating via NODETERM_NODE_ID), and posts the
// raw hook payload to the loopback server. Fails open at every step.
export function buildManagedScript(agentId: string): string {
  return [
    '#!/bin/sh',
    'if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then',
    '  . "$NODETERM_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$NODETERM_HOOK_TOKEN" ] || [ -z "$NODETERM_NODE_ID" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    'if [ -n "$NODETERM_HOOK_SOCK" ]; then',
    `  curl -sS -X POST --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/hook/${agentId}" \\`,
    '    --connect-timeout 0.5 --max-time 1.5 \\',
    '    -H "Content-Type: application/x-www-form-urlencoded" \\',
    '    -H "X-Nodeterm-Hook-Token: ${NODETERM_HOOK_TOKEN}" \\',
    '    --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '    --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '    --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'elif [ -n "$NODETERM_HOOK_PORT" ]; then',
    `  curl -sS -X POST "http://127.0.0.1:\${NODETERM_HOOK_PORT}/hook/${agentId}" \\`,
    '    --connect-timeout 0.5 --max-time 1.5 \\',
    '    -H "Content-Type: application/x-www-form-urlencoded" \\',
    '    -H "X-Nodeterm-Hook-Token: ${NODETERM_HOOK_TOKEN}" \\',
    '    --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '    --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '    --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'fi',
    'exit 0',
    ''
  ].join('\n')
}

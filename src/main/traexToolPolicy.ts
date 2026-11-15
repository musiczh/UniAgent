// TraeX disables tools by exact native name; wildcard and --allowed-tool do not form an allowlist.
export const TRAEX_NATIVE_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'Bash', 'PowerShell', 'Monitor', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'ListAgents', 'SendMessage', 'CloseAgent', 'Skill', 'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'GoalGet', 'GoalCreate', 'GoalUpdate',
  'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
  'exec_command', 'write_stdin', 'apply_patch', 'view_image', 'list_mcp_resources', 'list_mcp_resource_templates',
  'read_mcp_resource', 'request_user_input', 'update_plan', 'spawn_agent', 'send_message', 'wait_agent',
  'resume_agent', 'close_agent', 'exec', 'wait'
]

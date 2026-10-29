type Task = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }

/** Native Task tools report incremental updates; TodoWrite's snapshot semantics do not apply. */
export function updateClaudeTaskPlan(tasks: Map<string, Task>, name: string, input: any, result: any): Task[] | undefined {
  if (!['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].includes(name) || result?.success === false || result?.error) return
  if (name === 'TaskList' && Array.isArray(result?.tasks)) {
    tasks.clear()
    for (const task of result.tasks) set(task)
  } else if (name === 'TaskCreate' && result?.task) set({ ...result.task, status: 'pending' })
  else if (name === 'TaskGet' && result?.task) set(result.task)
  else if (name === 'TaskUpdate') {
    const id = String(result?.taskId ?? input?.taskId ?? '')
    if (!id) return
    if (input?.status === 'deleted' || result?.statusChange?.to === 'deleted') tasks.delete(id)
    else {
      const previous = tasks.get(id)
      if (!previous && !input?.subject) return
      set({ id, subject: input?.subject ?? previous?.content, status: result?.statusChange?.to ?? input?.status ?? previous?.status })
    }
  } else return
  return [...tasks.values()]

  function set(task: any): void {
    if (!task || typeof task.id !== 'string' || !task.id || typeof task.subject !== 'string') return
    tasks.set(task.id, { id: task.id, content: task.subject,
      status: task.status === 'completed' ? 'completed' : task.status === 'in_progress' ? 'in_progress' : 'pending' })
  }
}

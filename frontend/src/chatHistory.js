// Keep the visible transcript, but send only the recent context the API accepts.
export function chatHistory(messages) {
  const recent = messages.filter(m => !m.error).slice(-20);
  const firstUser = recent.findIndex(m => m.role === 'user');
  return firstUser < 0 ? [] : recent.slice(firstUser).map(({ role, content }) => ({
    role, content: content.slice(0, 2000),
  }));
}

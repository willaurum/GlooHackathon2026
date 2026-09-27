export async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

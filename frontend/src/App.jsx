import { useEffect, useState } from 'react'

async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.status === 204 ? null : res.json()
}

export default function App() {
  const [items, setItems] = useState([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState(null)

  const refresh = () =>
    api('/items').then(setItems).catch((e) => setError(e.message))

  useEffect(() => {
    refresh()
  }, [])

  async function addItem(e) {
    e.preventDefault()
    if (!title.trim()) return
    try {
      await api('/items', { method: 'POST', body: JSON.stringify({ title }) })
      setTitle('')
      refresh()
    } catch (e) {
      setError(e.message)
    }
  }

  async function toggle(item) {
    try {
      await api(`/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done: !item.done }),
      })
      refresh()
    } catch (e) {
      setError(e.message)
    }
  }

  async function remove(item) {
    try {
      await api(`/items/${item.id}`, { method: 'DELETE' })
      refresh()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <main>
      <h1>Gloo demo</h1>
      <p className="sub">React &rarr; FastAPI &rarr; Postgres, one docker compose up.</p>
      {error && <p className="error">{error}</p>}

      <section>
        <h2>Tasks <span className="tag">SQL</span></h2>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => toggle(item)}
                />
                <span className={item.done ? 'done' : ''}>{item.title}</span>
              </label>
              <button className="remove" onClick={() => remove(item)} title="Delete">
                &times;
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="empty">Nothing here yet.</li>}
        </ul>
        <form onSubmit={addItem}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a task"
          />
          <button type="submit">Add</button>
        </form>
      </section>
    </main>
  )
}

import { useEffect, useRef, useState } from 'react';
import { chatHistory } from './chatHistory.js';

const greeting = 'Hi! I’m Belong, Grace Community’s assistant. I can help with service times, events, small groups, or finding a place to serve.';
const starters = ['When are services?', 'How can I get involved?', 'Are there small groups?'];
const actionLabels = {
  request_connection: 'Connection request saved for staff review',
  hand_off_to_staff: 'Request saved for staff review'
};
const newSessionId = () => globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2);

export default function ChatWidget({ onRequestFiled }) {
  const [open, setOpen] = useState(false),
    [messages, setMessages] = useState([]),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [configured, setConfigured] = useState(true),
    [sessionId] = useState(newSessionId),
    log = useRef(null);
  useEffect(() => {
    fetch('/api/chat/status').then(r => r.json()).then(s => setConfigured(s.configured)).catch(() => {});
  }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, busy, open]);
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    // Failed replies stay on screen but are never sent back as history.
    const history = [...messages, { role: 'user', content: text }];
    setMessages(history); setInput(''); setBusy(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, messages: chatHistory(history) })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Something went wrong. Please try again.');
      setConfigured(body.configured);
      setMessages(previous => [...previous, { role: 'assistant', content: body.reply, actions: body.actions }]);
      if (body.actions?.length) onRequestFiled?.();
    } catch (err) {
      setMessages(previous => [...previous, { role: 'assistant', content: err.message, error: true }]);
    } finally { setBusy(false); }
  }
  return <div className="chat">
    {open && <section className="chat-panel" aria-label="Chat with Belong">
      <div className="chat-head"><span className="icon color1">✧</span><div><strong>Ask Belong</strong><small>AI assistant · Staff review every request</small></div><button className="close" aria-label="Close chat" onClick={() => setOpen(false)}>×</button></div>
      {!configured && <div className="chat-banner">Demo mode: basic church information and requests are available. AI conversation is not configured.</div>}
      <div className="chat-log" ref={log} aria-live="polite">
        <p className="bubble assistant">{greeting}</p>
        {messages.map((m, i) => <div key={i} className={'bubble ' + m.role + (m.error ? ' error' : '')}>
          {m.content}
          {m.actions?.map(a => <span className="chat-action" key={a.request_id}>✓ {actionLabels[a.tool] ?? 'Done'}</span>)}
        </div>)}
        {busy && <p className="bubble assistant typing">Thinking…</p>}
        {!messages.length && <div className="chat-starters">{starters.map(s => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>}
      </div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(input); }}>
        <input aria-label="Message" value={input} maxLength={2000} onChange={e => setInput(e.target.value)} placeholder="Ask a question…" disabled={busy} />
        <button className="primary" disabled={busy || !input.trim()}>Send</button>
      </form>
      <small className="chat-note">Not for emergencies. In a crisis call or text 988, or call 911.</small>
    </section>}
    <button className="chat-toggle primary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '×' : '✧ Ask Belong'}</button>
  </div>;
}

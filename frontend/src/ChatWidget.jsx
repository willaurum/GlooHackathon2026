import { useEffect, useRef, useState } from 'react';
import { API_BASE } from './api.js';
import Icon from './Icon.jsx';
import { chatHistory } from './chatHistory.js';
import { navigationPage, followSuggestion } from './chatNavigation.js';
import { formatReply } from './chatFormat.js';

const greeting = 'Hi! I’m Belong, Grace Community’s assistant. I can help with service times, events, small groups, or finding a place to serve.';
const starters = ['When are services?', 'How can I get involved?', 'Are there small groups?'];
const actionLabels = {
  request_connection: 'Connection request saved for staff review',
  hand_off_to_staff: 'Request saved for staff review'
};
const Segments = ({ segments }) => segments.map((s, i) =>
  s.bold ? <strong key={i}>{s.text}</strong> : s.italic ? <em key={i}>{s.text}</em> : s.text);
const Reply = ({ text }) => <div className="chat-text">{formatReply(text).map((block, i) => block.type === 'p'
  ? <p key={i}><Segments segments={block.segments} /></p>
  : <block.type key={i}>{block.items.map((item, j) => <li key={j}><Segments segments={item} /></li>)}</block.type>)}</div>;
const newSessionId = () => globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2);

export default function ChatWidget({ open, setOpen, onRequestFiled, onNavigate }) {
  const [messages, setMessages] = useState([]),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [configured, setConfigured] = useState(true),
    [sessionId] = useState(newSessionId),
    log = useRef(null);
  useEffect(() => {
    fetch(API_BASE + '/api/chat/status').then(r => r.json()).then(s => setConfigured(s.configured)).catch(() => {});
  }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, busy, open]);
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    // Failed replies stay on screen but are never sent back as history.
    const history = [...messages, { role: 'user', content: text }];
    setMessages(history); setInput(''); setBusy(true);
    try {
      const response = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, messages: chatHistory(history) })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Something went wrong. Please try again.');
      setConfigured(body.configured);
      setMessages(previous => [...previous, { role: 'assistant', content: body.reply, actions: body.actions }]);
      if (body.actions?.some(a => a.request_id)) onRequestFiled?.();
    } catch (err) {
      setMessages(previous => [...previous, { role: 'assistant', content: err.message, error: true }]);
    } finally { setBusy(false); }
  }
  return <div className="chat">
    {open && <section className="chat-panel" aria-label="Chat with Belong">
      <div className="chat-head"><span className="icon color1"><Icon name="sparkle" size={20} /></span><div><strong>Ask Belong</strong><small>AI assistant · Staff review every request</small></div><button className="close" aria-label="Close chat" onClick={() => setOpen(false)}><Icon name="x" /></button></div>
      {!configured && <div className="chat-banner">Demo mode: no AI key is configured, so answers come from simple built-in replies.</div>}
      <div className="chat-log" ref={log} aria-live="polite">
        <p className="bubble assistant">{greeting}</p>
        {messages.map((m, i) => <div key={i} className={'bubble ' + m.role + (m.error ? ' error' : '')}>
          {m.role === 'assistant' && !m.error ? <Reply text={m.content} /> : m.content}
          {m.actions?.map(a => {
            const page = navigationPage(a);
            if (page) return <div className="chat-page" key={a.page}><strong>{page}</strong><button type="button" className="secondary" aria-label={'Take me to ' + page} onClick={() => {
              if (followSuggestion(a, onNavigate)) setOpen(false);
            }}>Take me there<Icon name="arrow" size={16} /></button></div>;
            return a.request_id && actionLabels[a.tool] ? <span className="chat-action" key={a.request_id}><Icon name="check" size={16} />{actionLabels[a.tool]}</span> : null;
          })}
        </div>)}
        {busy && <p className="bubble assistant typing">Thinking…</p>}
        {!messages.length && <div className="chat-starters">{starters.map(s => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>}
      </div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(input); }}>
        <input aria-label="Message" value={input} maxLength={2000} onChange={e => setInput(e.target.value)} placeholder="Ask a question…" disabled={busy} />
        <button className="primary" aria-label="Send" disabled={busy || !input.trim()}><Icon name="arrow" size={18} /></button>
      </form>
      <small className="chat-note">Not for emergencies. In a crisis call or text 988, or call 911.</small>
    </section>}
    {!open && <button className="chat-toggle primary" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="chat" size={18} />Ask Belong</button>}
  </div>;
}

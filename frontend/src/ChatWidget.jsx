import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useChurch } from './ChurchContext.js';
import Icon from './Icon.jsx';
import { chatHistory } from './chatHistory.js';
import { navigationPage, followSuggestion } from './chatNavigation.js';
import { formatReply } from './chatFormat.js';

const greetingFor = name => `Hi! I’m Tekton, ${name || 'the church'}’s assistant. I can help with service times, events, small groups, or finding a place to serve.`;
const starters = ['When are services?', 'How can I get involved?', 'Are there small groups?'];
const actionLabels = {
  request_connection: 'Application saved for staff review',
  hand_off_to_staff: 'Request saved for staff review'
};
const Segments = ({ segments }) => segments.map((s, i) =>
  s.bold ? <strong key={i}>{s.text}</strong> : s.italic ? <em key={i}>{s.text}</em> : s.text);
const Reply = ({ text }) => <div className="chat-text">{formatReply(text).map((block, i) => block.type === 'p'
  ? <p key={i}><Segments segments={block.segments} /></p>
  : <block.type key={i}>{block.items.map((item, j) => <li key={j}><Segments segments={item} /></li>)}</block.type>)}</div>;
const newSessionId = () => globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2);

export default function ChatWidget({ open, setOpen, onNavigate }) {
  const church = useChurch();
  const greeting = church.ready ? greetingFor(church.name) : `The ${church.name} assistant opens as soon as the updated church service is deployed.`;
  const [messages, setMessages] = useState([]),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [configured, setConfigured] = useState(true),
    [sessionId] = useState(newSessionId),
    log = useRef(null), box = useRef(null);
  // An empty box (after sending) shrinks back to one line.
  useEffect(() => { if (box.current && !input) box.current.style.height = ''; }, [input]);
  useEffect(() => {
    if (!church.ready) return;
    api('/chat/status').then(s => setConfigured(s.configured)).catch(() => {});
  }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, busy, open]);
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    // Failed replies stay on screen but are never sent back as history.
    const history = [...messages, { role: 'user', content: text }];
    setMessages(history); setInput(''); setBusy(true);
    try {
      const body = await api('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, messages: chatHistory(history) })
      });
      setConfigured(body.configured);
      setMessages(previous => [...previous, { role: 'assistant', content: body.reply, actions: body.actions }]);
    } catch (err) {
      setMessages(previous => [...previous, { role: 'assistant', content: err.message, error: true }]);
    } finally { setBusy(false); }
  }
  return <div className="chat">
    {open && <section className="chat-panel" aria-label="Chat with Tekton">
      <div className="chat-head"><span className="icon color1"><Icon name="sparkle" size={20} /></span><div><strong>Ask Tekton</strong><small>AI assistant · Staff review every request</small></div><button className="close" aria-label="Close chat" onClick={() => setOpen(false)}><Icon name="x" /></button></div>
      {!configured && <div className="chat-banner">Basic church information is available. AI conversation is not configured.{church.preview && ' Staff requests open after your church is created.'}</div>}
      <div className="chat-log" ref={log} aria-live="polite">
        <p className="bubble assistant">{greeting}</p>
        {messages.map((m, i) => <div key={i} className={'bubble ' + m.role + (m.error ? ' error' : '')}>
          {m.role === 'assistant' && !m.error ? <Reply text={m.content} /> : m.content}
          {m.actions?.map(a => {
            const page = navigationPage(a);
            if (page) return <div className="chat-page" key={a.page + '/' + (a.section ?? '')}><strong>{page}</strong><button type="button" className="secondary" aria-label={'Take me to ' + page} onClick={() => {
              if (followSuggestion(a, onNavigate)) setOpen(false);
            }}>Take me there<Icon name="arrow" size={16} /></button></div>;
            const filed = a.request_id ?? a.application_id;
            return filed && actionLabels[a.tool] ? <span className="chat-action" key={a.tool + filed}><Icon name="check" size={16} />{actionLabels[a.tool]}</span> : null;
          })}
        </div>)}
        {busy && <p className="bubble assistant typing">Thinking…</p>}
        {!messages.length && church.ready && <div className="chat-starters">{starters.map(s => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>}
      </div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(input); }}>
        {/* Grows upward as the question gets longer (up to about five lines). Enter sends; Shift+Enter starts a new line. */}
        <textarea ref={box} aria-label="Message" rows={1} value={input} maxLength={2000} placeholder="Ask a question…" disabled={busy || !church.ready}
          onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 132) + 'px'; }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }} />
        <button className="primary" aria-label="Send" disabled={busy || !input.trim()}><Icon name="arrow" size={18} /></button>
      </form>
      <small className="chat-note">Not for emergencies. In a crisis call or text 988, or call 911.</small>
    </section>}
    {!open && <button className="chat-toggle primary" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="chat" size={18} />Ask Tekton</button>}
  </div>;
}

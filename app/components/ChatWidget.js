'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './ChatWidget.module.css';
import Markdown from './Markdown';

const INITIAL_MESSAGES = [
  {
    id: 'greeting',
    sender: 'bot',
    text: 'Hello! I can help with forecasting, trend analysis and engineering insights.',
    time: 'Just now',
  },
];

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [showNotif, setShowNotif] = useState(true);
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const historyRef = useRef([]);

  const chatBodyRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
    }
  }, [messages, typing]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 110)}px`;
    }
  }, [input]);

  const togglePanel = (forceOpen) => {
    const willOpen = forceOpen !== undefined ? forceOpen : !open;
    setOpen(willOpen);
    if (willOpen) {
      setShowNotif(false);
      textareaRef.current?.focus();
    }
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, sender: 'user', text, time: timeNow() },
    ]);
    setInput('');
    setTyping(true);

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: historyRef.current }),
    })
      .then((res) => res.json())
      .then((data) => {
        setTyping(false);
        if (data.error) {
          setMessages((prev) => [
            ...prev,
            { id: `b-${Date.now()}`, sender: 'bot', text: `Error: ${data.error}`, time: timeNow() },
          ]);
          return;
        }
        historyRef.current = data.history || historyRef.current;
        setMessages((prev) => [
          ...prev,
          { id: `b-${Date.now()}`, sender: 'bot', text: data.reply, time: timeNow() },
        ]);
      })
      .catch((error) => {
        setTyping(false);
        setMessages((prev) => [
          ...prev,
          { id: `b-${Date.now()}`, sender: 'bot', text: `Error: ${error.message}`, time: timeNow() },
        ]);
      });
  };

  const clearChat = () => {
    historyRef.current = [];
    setMessages([
      { id: `b-${Date.now()}`, sender: 'bot', text: 'Chat cleared. How can I help you today?', time: timeNow() },
    ]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      {/* hidden (not just visually) while the panel is open, so it never overlaps the chat */}
      <button
        className={`${styles.chatToggle} ${open ? styles.hidden : ''}`}
        onClick={() => togglePanel()}
        aria-label="Open chat"
        tabIndex={open ? -1 : 0}
      >
        <i className="fas fa-comment-dots"></i>
        {showNotif && <span className={styles.notifDot}></span>}
      </button>

      <div className={`${styles.chatPanel} ${open ? styles.open : ''}`}>
        <div className={styles.header}>
          <div className={styles.headerTop}>
            <div className={styles.brand}>
              <div className={styles.logo}>
                <i className="fas fa-chart-line"></i>
              </div>
              <div className={styles.brandText}>
                <h2>ForecastIQ</h2>
                <p><span className={styles.statusDot}></span> Online now</p>
              </div>
            </div>

            <div className={styles.headerActions}>
              <button className={styles.iconBtn} title="Clear chat" onClick={clearChat}>
                <i className="fas fa-rotate-left"></i>
              </button>
              <button className={styles.iconBtn} title="Close" onClick={() => togglePanel(false)}>
                <i className="fas fa-xmark"></i>
              </button>
            </div>
          </div>

          <div className={styles.tagline}>
            <h3>Ask. Analyze. Forecast.</h3>
            <p>Smarter decisions, faster.</p>
          </div>
        </div>

        <div className={styles.chatBody} ref={chatBodyRef}>
          {messages.map((m) => (
            <div key={m.id} className={`${styles.message} ${styles[m.sender]}`}>
              <div className={styles.avatar}>
                <i className={`fas ${m.sender === 'bot' ? 'fa-robot' : 'fa-user'}`}></i>
              </div>
              <div className={styles.bubbleWrap}>
                <div className={styles.bubble}>
                  <Markdown text={m.text} variant={m.sender === 'user' ? 'user' : 'bot'} />
                </div>
                <div className={styles.timestamp}>{m.time}</div>
              </div>
            </div>
          ))}

          {typing && (
            <div className={`${styles.message} ${styles.bot} ${styles.typing}`}>
              <div className={styles.avatar}>
                <i className="fas fa-robot"></i>
              </div>
              <div className={styles.bubbleWrap}>
                <div className={styles.bubble}>
                  <span></span><span></span><span></span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.inputArea}>
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Type your question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className={styles.sendBtn}
              onClick={sendMessage}
              disabled={input.trim() === ''}
            >
              <i className="fas fa-paper-plane"></i>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

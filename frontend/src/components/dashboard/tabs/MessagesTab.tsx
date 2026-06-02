"use client";
import React, { useState, useRef, useEffect } from 'react';
import { Send, CloudLightning, Bot } from 'lucide-react';

interface ChatMessage {
  id: string;
  sender: 'user' | 'other' | 'system';
  senderName: string;
  text: string;
  time: string;
}

export default function MessagesTab() {
  const [activeChat, setActiveChat] = useState<'eng' | 'marcus' | 'lena'>('eng');
  
  // Chats content state
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({
    eng: [
      { id: '1', sender: 'other', senderName: 'Devops Leader', text: 'Hey Admin! The server migration to the custom Asia-Pacific Cloud Run nodes is complete.', time: '09:12 AM' },
      { id: '2', sender: 'system', senderName: 'System', text: 'Gateway ping restored to 14.5ms avg.', time: '09:13 AM' },
      { id: '3', sender: 'user', senderName: 'Ava Donovan', text: 'Stellar work. Do we have the SHA logging integrity locks configured?', time: '09:15 AM' },
      { id: '4', sender: 'other', senderName: 'Devops Leader', text: 'Affirmative. Secure ledger structures are active.', time: '09:17 AM' },
    ],
    marcus: [
      { id: '1', sender: 'other', senderName: 'Marcus Bell', text: 'Hi, I need assistance with invoice TXN-001 - is there a premium module license included?', time: 'Yesterday' },
      { id: '2', sender: 'user', senderName: 'Ava Donovan', text: 'Let me double-check. Yes! Visa slip matches the Core Router v3 license setup.', time: 'Yesterday' },
      { id: '3', sender: 'other', senderName: 'Marcus Bell', text: 'Perfect, got the PDF copy. Thank you!', time: '10:00 AM' }
    ],
    lena: [
      { id: '1', sender: 'other', senderName: 'Lena Ortiz', text: 'Hello Ava! Can you upgrade our billing limit terms today? We have a high influx of direct referrers.', time: '08:45 AM' }
    ]
  });

  const [inputMessage, setInputMessage] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chats, activeChat]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if(!inputMessage.trim()) return;

    const userMsg: ChatMessage = {
      id: Math.random().toString(),
      sender: 'user',
      senderName: 'Ava Donovan',
      text: inputMessage.trim(),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    };

    const currentChat = chats[activeChat];
    const updatedChat = [...currentChat, userMsg];
    
    setChats({
      ...chats,
      [activeChat]: updatedChat
    });

    setInputMessage('');

    // Trigger simulated response
    setTimeout(() => {
      let replyText = "Confirming received admin instruction. Queuing task into system pipeline...";
      let responder = "Service Node";

      if(activeChat === 'eng') {
        replyText = "Asia-Pacific telemetry checks completed. All services reporting normal operations, Ava!";
        responder = "Devops Leader";
      } else if (activeChat === 'marcus') {
        replyText = "Got it! Thanks for keeping things organized. Highly appreciate the superb service!";
        responder = "Marcus Bell";
      } else if (activeChat === 'lena') {
        replyText = "Greatly appreciate your prompt support, Ava. Looking forward to reviewing the terms!";
        responder = "Lena Ortiz";
      }

      const botReply: ChatMessage = {
        id: Math.random().toString(),
        sender: 'other',
        senderName: responder,
        text: replyText,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      };

      setChats(prev => ({
        ...prev,
        [activeChat]: [...prev[activeChat], botReply]
      }));

    }, 1200);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 tweak-transition h-[550px] items-stretch">
      
      {/* Left side chats list */}
      <div 
        className="card md:col-span-1 bg-[var(--surface)] border border-[var(--border)] p-4 shadow-xs flex flex-col justify-between"
        style={{ borderRadius: 'var(--radius)' }}
      >
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">Workspace Chats</h3>
            <p className="text-[11px] text-[var(--muted)]">Communicate with engineers or client sectors</p>
          </div>

          <div className="space-y-2">
            {[
              { id: 'eng', name: 'Engineering Ops', desc: 'Telemetry & security syncs', av: '#7b6ef0', isGroup: true },
              { id: 'marcus', name: 'Marcus Bell (Client)', desc: 'Enterprise inquiry support', av: '#5b8def', isGroup: false },
              { id: 'lena', name: 'Lena Ortiz (Billing)', desc: 'Billing limit revisions', av: '#2bb39a', isGroup: false }
            ].map((c) => (
              <div 
                key={c.id}
                onClick={() => setActiveChat(c.id as typeof activeChat)}
                className={`p-3 rounded-xl border transition-all cursor-pointer flex gap-3 ${
                  activeChat === c.id 
                    ? 'border-[var(--accent)] bg-[var(--accent-6)]' 
                    : 'border-[var(--border-2)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <div 
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                  style={{ backgroundColor: c.av }}
                >
                  {c.name.substring(0,2).toUpperCase()}
                </div>
                <div className="leading-tight min-w-0">
                  <h4 className="text-xs font-extrabold text-[var(--ink)] truncate">{c.name}</h4>
                  <span className="text-[10px] text-[var(--faint)] block truncate mt-0.5">{c.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-[var(--border-2)] text-[10px] text-[var(--faint)] text-center font-bold">
          Encrypted via TLS End-to-End Tunnel
        </div>
      </div>

      {/* Right side Active Chat details */}
      <div 
        className="card md:col-span-2 bg-[var(--surface)] border border-[var(--border)] p-4 shadow-xs flex flex-col justify-between"
        style={{ borderRadius: 'var(--radius)' }}
      >
        {/* Chat partner header name */}
        <div className="pb-3 border-b border-[var(--border-2)] flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--pos)] animate-ping" />
          <span className="text-xs font-extrabold uppercase text-[var(--ink)] tracking-wider">
            {activeChat === 'eng' ? 'Engineering Operational Matrix' : 
             activeChat === 'marcus' ? 'Direct chat with Marcus' : 'Direct secure channel with Lena'}
          </span>
        </div>

        {/* Message Flows scroll segment */}
        <div className="flex-1 overflow-y-auto space-y-3.5 my-3.5 pr-2">
          {chats[activeChat].map((msg) => {
            const isMe = msg.sender === 'user';
            const isSys = msg.sender === 'system';

            if (isSys) {
              return (
                <div key={msg.id} className="mx-auto max-w-sm text-center">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-500/10 text-[var(--warn)] border border-amber-500/10 rounded-full text-[10px] font-bold uppercase tracking-wider">
                    <CloudLightning className="w-3 h-3" /> {msg.text} · {msg.time}
                  </span>
                </div>
              );
            }

            return (
              <div 
                key={msg.id} 
                className={`flex flex-col max-w-[80%] ${isMe ? 'ml-auto items-end' : 'mr-auto items-start'}`}
              >
                <div className="flex items-center gap-1.5 mb-1 text-[10px] font-extrabold text-[var(--faint)]">
                  {!isMe && <Bot className="w-3 h-3 text-[var(--accent)]" />}
                  <span>{msg.senderName}</span>
                </div>
                
                <div 
                  className={`p-3 text-xs leading-relaxed shadow-xs ${
                    isMe 
                      ? 'bg-[var(--accent)] text-white rounded-t-2xl rounded-bl-2xl font-semibold' 
                      : 'bg-[var(--surface-2)] text-[var(--ink)] border border-[var(--border)] rounded-t-2xl rounded-br-2xl'
                  }`}
                >
                  <p>{msg.text}</p>
                </div>

                <span className="text-[9px] text-[var(--faint)] font-bold mt-1 tracking-wider">{msg.time}</span>
              </div>
            );
          })}
          
          <div ref={chatEndRef} />
        </div>

        {/* Messaging footer input controller */}
        <form onSubmit={handleSend} className="flex gap-2 pt-3 border-t border-[var(--border-2)]">
          <input 
            type="text"
            placeholder="Type your secure administrator message..."
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            className="flex-1 bg-[var(--surface-2)] text-[var(--ink)] placeholder-semibold text-xs px-4 py-2.5 rounded-xl border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
          />
          <button 
            type="submit"
            className="p-2.5 bg-[var(--accent)] text-white rounded-xl hover:opacity-90 cursor-pointer shadow-xs transition-all flex items-center justify-center shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>

      </div>

    </div>
  );
}

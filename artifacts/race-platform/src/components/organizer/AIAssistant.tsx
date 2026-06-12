import { useState, useRef, useEffect, useCallback } from "react";
import { Bot, X, Send, Plus, Trash2, ChevronLeft, Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface Conversation {
  id: number;
  title: string;
  createdAt: string;
  messages?: Message[];
}

function MarkdownText({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} className="font-semibold text-sm mt-3 mb-1">{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="font-bold text-sm mt-3 mb-1">{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} className="font-bold text-base mt-2 mb-1">{line.slice(2)}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <li key={i} className="ml-4 list-disc text-sm leading-relaxed">
          {renderInline(line.slice(2))}
        </li>
      );
    } else if (/^\d+\. /.test(line)) {
      const match = line.match(/^(\d+)\. (.*)$/);
      if (match) {
        elements.push(
          <li key={i} className="ml-4 list-decimal text-sm leading-relaxed">
            {renderInline(match[2])}
          </li>
        );
      }
    } else if (line.trim() === "") {
      elements.push(<div key={i} className="h-1" />);
    } else {
      elements.push(
        <p key={i} className="text-sm leading-relaxed">
          {renderInline(line)}
        </p>
      );
    }
    i++;
  }

  return <div className="space-y-0.5">{elements}</div>;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="bg-black/10 px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

const QUICK_PROMPTS = [
  "How do I create a new event?",
  "How do I open registration for an event?",
  "How do I publish results?",
  "How do I set up RFID timing?",
  "How do I create a championship series?",
  "How do I check in riders on race day?",
];

export function AIAssistant() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "chat">("list");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [loadingConvs, setLoadingConvs] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  useEffect(() => {
    if (open && view === "list") loadConversations();
  }, [open, view]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamBuffer]);

  const loadConversations = async () => {
    setLoadingConvs(true);
    try {
      const res = await fetch("/api/anthropic/conversations");
      if (res.ok) setConversations(await res.json());
    } finally {
      setLoadingConvs(false);
    }
  };

  const openConversation = async (conv: Conversation) => {
    setActiveConv(conv);
    setView("chat");
    setLoadingMsgs(true);
    try {
      const res = await fetch(`/api/anthropic/conversations/${conv.id}`);
      if (res.ok) {
        const data: Conversation = await res.json();
        setMessages(data.messages ?? []);
      }
    } finally {
      setLoadingMsgs(false);
    }
  };

  const startNewConversation = async (firstMessage?: string) => {
    const msg = firstMessage ?? input.trim();
    if (!msg) return;

    const title = msg.length > 50 ? msg.slice(0, 47) + "…" : msg;
    const res = await fetch("/api/anthropic/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return;
    const conv: Conversation = await res.json();
    setActiveConv(conv);
    setMessages([]);
    setView("chat");
    if (!firstMessage) setInput("");
    await sendMessage(conv.id, msg);
  };

  const sendMessage = async (convId: number, text?: string) => {
    const content = text ?? input.trim();
    if (!content || streaming) return;

    setInput("");
    const userMsg: Message = {
      id: Date.now(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    setStreamBuffer("");
    scrollToBottom();

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/anthropic/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        setMessages((prev) => [
          ...prev,
          { id: Date.now(), role: "assistant", content: "Sorry, something went wrong. Please try again.", createdAt: new Date().toISOString() },
        ]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(part.slice(6));
            if (payload.done) {
              setMessages((prev) => [
                ...prev,
                { id: Date.now(), role: "assistant", content: full, createdAt: new Date().toISOString() },
              ]);
              setStreamBuffer("");
            } else if (payload.content) {
              full += payload.content;
              setStreamBuffer(full);
            } else if (payload.error) {
              setMessages((prev) => [
                ...prev,
                { id: Date.now(), role: "assistant", content: payload.error, createdAt: new Date().toISOString() },
              ]);
              setStreamBuffer("");
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { id: Date.now(), role: "assistant", content: "Connection error. Please try again.", createdAt: new Date().toISOString() },
        ]);
      }
    } finally {
      setStreaming(false);
      setStreamBuffer("");
      abortRef.current = null;
    }
  };

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    if (!activeConv) {
      startNewConversation();
    } else {
      sendMessage(activeConv.id);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const deleteConversation = async (e: React.MouseEvent, convId: number) => {
    e.stopPropagation();
    await fetch(`/api/anthropic/conversations/${convId}`, { method: "DELETE" });
    setConversations((prev) => prev.filter((c) => c.id !== convId));
  };

  const goBack = () => {
    abortRef.current?.abort();
    setView("list");
    setActiveConv(null);
    setMessages([]);
    setStreamBuffer("");
    loadConversations();
  };

  const handleOpen = () => {
    setOpen(true);
    setView("list");
  };

  const handleClose = () => {
    abortRef.current?.abort();
    setOpen(false);
  };

  const allMessages = streaming
    ? [...messages, { id: -1, role: "assistant" as const, content: streamBuffer, createdAt: "" }]
    : messages;

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={handleOpen}
        className={cn(
          "fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full px-4 py-3 shadow-lg transition-all",
          "bg-primary text-primary-foreground hover:bg-primary/90",
          "font-heading font-semibold text-sm uppercase tracking-wide",
          open && "opacity-0 pointer-events-none"
        )}
        aria-label="Open AI Assistant"
      >
        <Bot size={18} />
        <span className="hidden sm:inline">AI Assistant</span>
      </button>

      {/* Panel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col w-[380px] max-w-[calc(100vw-2rem)] h-[580px] max-h-[calc(100dvh-3rem)] rounded-2xl bg-background border border-border shadow-2xl overflow-hidden">

          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-primary text-primary-foreground shrink-0">
            {view === "chat" && (
              <button onClick={goBack} className="p-1 rounded hover:bg-white/10 transition-colors" aria-label="Back">
                <ChevronLeft size={18} />
              </button>
            )}
            <Bot size={20} />
            <div className="flex-1 min-w-0">
              <div className="font-heading font-bold text-sm uppercase tracking-wider">AI Assistant</div>
              {view === "chat" && activeConv && (
                <div className="text-xs text-primary-foreground/70 truncate">{activeConv.title}</div>
              )}
            </div>
            <button onClick={handleClose} className="p-1 rounded hover:bg-white/10 transition-colors" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          {/* List view */}
          {view === "list" && (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="px-4 pt-4 pb-2 shrink-0">
                <button
                  onClick={() => { setView("chat"); setActiveConv(null); setMessages([]); }}
                  className="w-full flex items-center gap-2 rounded-xl border-2 border-dashed border-border/60 px-4 py-3 text-sm text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
                >
                  <Plus size={16} />
                  New conversation
                </button>
              </div>

              <ScrollArea className="flex-1 px-4 pb-4">
                {loadingConvs ? (
                  <div className="flex justify-center py-8">
                    <Loader2 size={20} className="animate-spin text-muted-foreground" />
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="py-6 text-center">
                    <MessageSquare size={32} className="mx-auto text-muted-foreground/40 mb-3" />
                    <p className="text-sm text-muted-foreground font-medium">Ask me anything about the platform</p>
                    <div className="mt-4 flex flex-col gap-2">
                      {QUICK_PROMPTS.map((p) => (
                        <button
                          key={p}
                          onClick={() => startNewConversation(p)}
                          className="text-left text-xs px-3 py-2 rounded-lg bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 pt-1">
                    {conversations.map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => openConversation(conv)}
                        className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-muted/60 transition-colors"
                      >
                        <MessageSquare size={16} className="text-muted-foreground shrink-0" />
                        <span className="flex-1 text-sm truncate">{conv.title}</span>
                        <button
                          onClick={(e) => deleteConversation(e, conv.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all"
                          aria-label="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
          )}

          {/* Chat view */}
          {view === "chat" && (
            <div className="flex flex-col flex-1 overflow-hidden">
              <ScrollArea className="flex-1 px-4 py-3">
                {loadingMsgs ? (
                  <div className="flex justify-center py-8">
                    <Loader2 size={20} className="animate-spin text-muted-foreground" />
                  </div>
                ) : allMessages.length === 0 ? (
                  <div className="py-6 text-center">
                    <Bot size={28} className="mx-auto text-muted-foreground/40 mb-2" />
                    <p className="text-sm text-muted-foreground">Ask me anything — I'll walk you through it.</p>
                    <div className="mt-4 flex flex-col gap-2">
                      {QUICK_PROMPTS.slice(0, 4).map((p) => (
                        <button
                          key={p}
                          onClick={() => startNewConversation(p)}
                          className="text-left text-xs px-3 py-2 rounded-lg bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    {allMessages.map((msg, idx) => (
                      <div
                        key={msg.id === -1 ? `stream-${idx}` : msg.id}
                        className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
                      >
                        {msg.role === "assistant" && (
                          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5">
                            <Bot size={14} className="text-primary" />
                          </div>
                        )}
                        <div
                          className={cn(
                            "max-w-[85%] rounded-2xl px-3.5 py-2.5",
                            msg.role === "user"
                              ? "bg-primary text-primary-foreground rounded-br-sm"
                              : "bg-muted text-foreground rounded-bl-sm"
                          )}
                        >
                          {msg.role === "assistant" ? (
                            <>
                              <MarkdownText text={msg.content || "…"} />
                              {msg.id === -1 && (
                                <span className="inline-block w-1.5 h-4 ml-0.5 bg-current opacity-70 animate-pulse rounded-sm align-middle" />
                              )}
                            </>
                          ) : (
                            <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    <div ref={bottomRef} />
                  </div>
                )}
              </ScrollArea>

              {/* Input */}
              <div className="px-3 pb-3 pt-2 border-t border-border shrink-0">
                <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 focus-within:border-primary/50 transition-colors">
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything…"
                    className="flex-1 resize-none border-0 bg-transparent p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 min-h-[20px] max-h-[120px]"
                    rows={1}
                    disabled={streaming}
                  />
                  <Button
                    size="icon"
                    className="h-7 w-7 shrink-0 rounded-lg"
                    onClick={handleSend}
                    disabled={!input.trim() || streaming}
                  >
                    {streaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground/60 text-center mt-1.5">
                  Press Enter to send · Shift+Enter for new line
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

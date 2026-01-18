import React, { useMemo, useRef, useState, useEffect } from "react";

const SYSTEM_PROMPT =
  "You are a helpful research assistant. Provide concise, precise explanations, " +
  "use structured reasoning, and cite key assumptions when relevant.";

const API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

const formatBranchMessage = (selectionText, userText) => {
  return (
    "Use the highlighted excerpt as context for this new branch.\n\n" +
    `Excerpt:\n"""${selectionText}"""\n\n` +
    `User: ${userText}`
  );
};

const createRootNode = () => ({
  id: "root",
  parentId: null,
  title: "Root",
  messages: [
    {
      role: "assistant",
      content:
        "Start a conversation and create branches by highlighting text in the chat.",
    },
  ],
});

const buildChildrenMap = (nodesById) => {
  const map = {};
  Object.values(nodesById).forEach((node) => {
    const parent = node.parentId ?? "root-parent";
    if (!map[parent]) {
      map[parent] = [];
    }
    map[parent].push(node.id);
  });
  return map;
};

const useClickOutside = (ref, handler) => {
  useEffect(() => {
    const listener = (event) => {
      if (!ref.current || ref.current.contains(event.target)) {
        return;
      }
      handler(event);
    };
    document.addEventListener("mousedown", listener);
    return () => document.removeEventListener("mousedown", listener);
  }, [ref, handler]);
};

const App = () => {
  const [nodesById, setNodesById] = useState(() => ({
    root: createRootNode(),
  }));
  const [activeNodeId, setActiveNodeId] = useState("root");
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectionPopover, setSelectionPopover] = useState({
    visible: false,
    text: "",
    rect: null,
    draft: "",
  });

  const chatAreaRef = useRef(null);
  const popoverRef = useRef(null);

  const activeNode = nodesById[activeNodeId];
  const childrenMap = useMemo(() => buildChildrenMap(nodesById), [nodesById]);

  useClickOutside(popoverRef, () => {
    if (selectionPopover.visible) {
      setSelectionPopover({ visible: false, text: "", rect: null, draft: "" });
    }
  });

  const addNode = (parentId, title, messages) => {
    const id = crypto.randomUUID();
    setNodesById((prev) => ({
      ...prev,
      [id]: {
        id,
        parentId,
        title,
        messages,
      },
    }));
    setActiveNodeId(id);
    return id;
  };

  const updateNodeMessages = (nodeId, updater) => {
    setNodesById((prev) => {
      const node = prev[nodeId];
      if (!node) return prev;
      return {
        ...prev,
        [nodeId]: {
          ...node,
          messages: updater(node.messages),
        },
      };
    });
  };

  const sendToOpenAI = async (messages) => {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing VITE_OPENAI_API_KEY in .env");
    }
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.2,
      }),
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${details}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  };

  const handleSend = async (content) => {
    if (!content.trim() || isLoading) return;
    setError("");
    const trimmed = content.trim();
    updateNodeMessages(activeNodeId, (messages) => [
      ...messages,
      { role: "user", content: trimmed },
    ]);
    setDraft("");
    setIsLoading(true);
    try {
      const node = nodesById[activeNodeId];
      const reply = await sendToOpenAI([
        ...node.messages,
        { role: "user", content: trimmed },
      ]);
      updateNodeMessages(activeNodeId, (messages) => [
        ...messages,
        { role: "assistant", content: reply || "No response returned." },
      ]);
    } catch (err) {
      setError(err.message || "Failed to reach OpenAI.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleBranchSend = async () => {
    if (!selectionPopover.text.trim() || !selectionPopover.draft.trim()) {
      return;
    }
    setError("");
    const userMessage = formatBranchMessage(
      selectionPopover.text.trim(),
      selectionPopover.draft.trim(),
    );
    const title = selectionPopover.draft.trim().slice(0, 48) || "New branch";
    const newNodeId = addNode(activeNodeId, title, [
      { role: "user", content: userMessage },
    ]);
    setSelectionPopover({ visible: false, text: "", rect: null, draft: "" });
    setIsLoading(true);
    try {
      const reply = await sendToOpenAI([{ role: "user", content: userMessage }]);
      updateNodeMessages(newNodeId, (messages) => [
        ...messages,
        { role: "assistant", content: reply || "No response returned." },
      ]);
    } catch (err) {
      setError(err.message || "Failed to reach OpenAI.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setSelectionPopover({ visible: false, text: "", rect: null, draft: "" });
      return;
    }
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      !chatAreaRef.current ||
      !chatAreaRef.current.contains(anchorNode) ||
      !chatAreaRef.current.contains(focusNode)
    ) {
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setSelectionPopover({ visible: false, text: "", rect: null, draft: "" });
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const top = Math.max(rect.top - 12, 12);
    const left = Math.min(rect.left, window.innerWidth - 320);
    setSelectionPopover({
      visible: true,
      text,
      rect: { top, left },
      draft: "",
    });
  };

  const renderTree = (nodeId, depth = 0) => {
    const node = nodesById[nodeId];
    const children = childrenMap[nodeId] || [];
    return (
      <div key={nodeId}>
        <button
          className={`tree-item ${activeNodeId === nodeId ? "active" : ""}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => setActiveNodeId(nodeId)}
          type="button"
        >
          <span className="tree-title">{node.title}</span>
        </button>
        {children.map((childId) => renderTree(childId, depth + 1))}
      </div>
    );
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Chat Tree</h1>
          <p>Branches update as you highlight text.</p>
        </div>
        <div className="tree">{renderTree("root")}</div>
      </aside>
      <main className="chat">
        <header className="chat-header">
          <div>
            <h2>{activeNode.title}</h2>
            <span className="chat-meta">
              {activeNode.messages.length} messages
            </span>
          </div>
          {isLoading && <span className="loading">Thinking...</span>}
        </header>
        <section
          className="chat-area"
          ref={chatAreaRef}
          onMouseUp={handleSelection}
        >
          {activeNode.messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`message ${message.role}`}
            >
              <div className="message-role">
                {message.role === "user" ? "You" : "Assistant"}
              </div>
              <div className="message-content">{message.content}</div>
            </div>
          ))}
          {error && <div className="error-banner">{error}</div>}
        </section>
        <footer className="chat-input">
          <textarea
            placeholder="Ask something in this node..."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
          />
          <button
            type="button"
            onClick={() => handleSend(draft)}
            disabled={isLoading || !draft.trim()}
          >
            Send
          </button>
        </footer>
      </main>
      {selectionPopover.visible && selectionPopover.rect && (
        <div
          ref={popoverRef}
          className="selection-popover"
          style={{
            top: `${selectionPopover.rect.top}px`,
            left: `${selectionPopover.rect.left}px`,
          }}
        >
          <div className="selection-title">Branch from highlight</div>
          <div className="selection-preview">
            “{selectionPopover.text.slice(0, 140)}”
          </div>
          <textarea
            placeholder="Ask a new question for this branch..."
            value={selectionPopover.draft}
            onChange={(event) =>
              setSelectionPopover((prev) => ({
                ...prev,
                draft: event.target.value,
              }))
            }
            rows={3}
          />
          <div className="selection-actions">
            <button
              type="button"
              onClick={() =>
                setSelectionPopover({
                  visible: false,
                  text: "",
                  rect: null,
                  draft: "",
                })
              }
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleBranchSend}
              disabled={isLoading || !selectionPopover.draft.trim()}
            >
              Create branch
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;

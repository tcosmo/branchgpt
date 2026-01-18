import React, { useMemo, useRef, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";

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

const summarizeTitle = (text) => {
  const cleaned = text
    .replace(/[\u2014\u2013]/g, " ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "New branch";
  const words = cleaned.split(" ");
  return words.slice(0, 2).join(" ");
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

const getNodePathToRoot = (nodeId, nodesById) => {
  const path = [];
  const visited = new Set();
  let currentId = nodeId;
  while (currentId && nodesById[currentId] && !visited.has(currentId)) {
    visited.add(currentId);
    path.push(currentId);
    currentId = nodesById[currentId].parentId;
  }
  return path.reverse();
};

const buildContextMessages = (nodeId, nodesById) => {
  const path = getNodePathToRoot(nodeId, nodesById);
  return path.flatMap((id) => nodesById[id]?.messages ?? []);
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
  const [treeView, setTreeView] = useState("graph");
  const [selectionPopover, setSelectionPopover] = useState({
    visible: false,
    text: "",
    rect: null,
    draft: "",
    placement: "above",
  });

  const chatAreaRef = useRef(null);
  const inputRef = useRef(null);
  const popoverRef = useRef(null);

  const activeNode = nodesById[activeNodeId];
  const childrenMap = useMemo(() => buildChildrenMap(nodesById), [nodesById]);
  const markdownComponents = useMemo(
    () => ({
      code({ inline, className, children, ...props }) {
        if (inline) {
          return (
            <code className={`inline-code ${className || ""}`} {...props}>
              {children}
            </code>
          );
        }
        return (
          <pre className="code-block">
            <code className={className} {...props}>
              {children}
            </code>
          </pre>
        );
      },
    }),
    [],
  );
  const graphLayout = useMemo(() => {
    const positions = {};
    const edges = [];
    let xCursor = 80;
    let maxDepth = 0;

    const walk = (nodeId, depth) => {
      maxDepth = Math.max(maxDepth, depth);
      const children = childrenMap[nodeId] || [];
      if (children.length === 0) {
        positions[nodeId] = { x: xCursor, y: depth * 160 + 70 };
        xCursor += 220;
        return;
      }
      children.forEach((childId) => {
        edges.push({ from: nodeId, to: childId });
        walk(childId, depth + 1);
      });
      const childXs = children.map((childId) => positions[childId].x);
      const mid = (Math.min(...childXs) + Math.max(...childXs)) / 2;
      positions[nodeId] = { x: mid, y: depth * 160 + 70 };
    };

    walk("root", 0);

    return {
      positions,
      edges,
      width: Math.max(xCursor + 120, 240),
      height: (maxDepth + 1) * 160 + 120,
    };
  }, [childrenMap]);

  useClickOutside(popoverRef, () => {
    if (selectionPopover.visible) {
      setSelectionPopover({
        visible: false,
        text: "",
        rect: null,
        draft: "",
        placement: "above",
      });
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
    const contextMessages = buildContextMessages(activeNodeId, nodesById);
    updateNodeMessages(activeNodeId, (messages) => [
      ...messages,
      { role: "user", content: trimmed },
    ]);
    setDraft("");
    setIsLoading(true);
    try {
      const reply = await sendToOpenAI([
        ...contextMessages,
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
    const contextMessages = buildContextMessages(activeNodeId, nodesById);
    const title = summarizeTitle(selectionPopover.draft.trim());
    const newNodeId = addNode(activeNodeId, title, [
      { role: "user", content: userMessage },
    ]);
    setSelectionPopover({
      visible: false,
      text: "",
      rect: null,
      draft: "",
      placement: "above",
    });
    setIsLoading(true);
    try {
      const reply = await sendToOpenAI([
        ...contextMessages,
        { role: "user", content: userMessage },
      ]);
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
      setSelectionPopover({
        visible: false,
        text: "",
        rect: null,
        draft: "",
        placement: "above",
      });
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
      setSelectionPopover({
        visible: false,
        text: "",
        rect: null,
        draft: "",
        placement: "above",
      });
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const placement = rect.top > 220 ? "above" : "below";
    const top = placement === "above" ? rect.top - 8 : rect.bottom + 8;
    const left = Math.min(rect.left, window.innerWidth - 320);
    setSelectionPopover({
      visible: true,
      text,
      rect: { top, left },
      draft: "",
      placement,
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

  const resizeInput = (element) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  };

  useEffect(() => {
    resizeInput(inputRef.current);
  }, [draft]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Chat Tree</h1>
          <p>Branches update as you highlight text.</p>
          <div className="view-toggle">
            <button
              type="button"
              className={treeView === "graph" ? "active" : ""}
              onClick={() => setTreeView("graph")}
              aria-label="Graph view"
              title="Graph view"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="6" cy="6" r="2.5" />
                <circle cx="18" cy="6" r="2.5" />
                <circle cx="12" cy="18" r="2.5" />
                <path d="M8 6h8M7.5 7.5l3.5 8M16.5 7.5l-3.5 8" />
              </svg>
            </button>
            <button
              type="button"
              className={treeView === "list" ? "active" : ""}
              onClick={() => setTreeView("list")}
              aria-label="List view"
              title="List view"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
        {treeView === "graph" ? (
          <div className="tree-graph">
            <svg
              width="100%"
              height={graphLayout.height}
              viewBox={`0 0 ${graphLayout.width} ${graphLayout.height}`}
            >
              {graphLayout.edges.map((edge) => {
                const from = graphLayout.positions[edge.from];
                const to = graphLayout.positions[edge.to];
                if (!from || !to) return null;
                return (
                  <line
                    key={`${edge.from}-${edge.to}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    className="graph-edge"
                  />
                );
              })}
              {Object.entries(graphLayout.positions).map(([nodeId, pos]) => {
                const node = nodesById[nodeId];
                const words = node.title.split(" ").filter(Boolean);
                return (
                  <g
                    key={nodeId}
                    className={`graph-node ${nodeId === activeNodeId ? "active" : ""
                      }`}
                    onClick={() => setActiveNodeId(nodeId)}
                  >
                    <circle cx={pos.x} cy={pos.y} r="34" />
                    <text x={pos.x} y={pos.y} textAnchor="middle">
                      {words.length > 1 ? (
                        <>
                          <tspan x={pos.x} dy="-6">
                            {words[0]}
                          </tspan>
                          <tspan x={pos.x} dy="14">
                            {words.slice(1).join(" ")}
                          </tspan>
                        </>
                      ) : (
                        <tspan x={pos.x} dy="4">
                          {words[0]}
                        </tspan>
                      )}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        ) : (
          <div className="tree">{renderTree("root")}</div>
        )}
      </aside>
      <main className="chat">
        <div className="chat-frame">
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
                <div className="message-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
                    rehypePlugins={[rehypeKatex]}
                    components={markdownComponents}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
            {error && <div className="error-banner">{error}</div>}
          </section>
          <footer className="chat-input">
            <textarea
              ref={inputRef}
              placeholder="Ask anything"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                resizeInput(event.target);
              }}
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
        </div>
      </main>
      {selectionPopover.visible && selectionPopover.rect && (
        <div
          ref={popoverRef}
          className="selection-popover"
          data-placement={selectionPopover.placement}
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
                  placement: "above",
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

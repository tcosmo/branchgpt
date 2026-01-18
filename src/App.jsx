import React, {
  useMemo,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";

const SYSTEM_PROMPT =
  "You are a helpful research assistant. Provide concise, precise explanations, " +
  "use structured reasoning, and cite key assumptions when relevant.";

const API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5.2";

const BRANCH_HL_START = "[[[hl:";
const BRANCH_HL_END = "[[[/hl]]]";
const TEMP_HL_START = "[[[sel:";
const TEMP_HL_END = "[[[/sel]]]";

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

const normalizeGeneratedTitle = (title, fallback = "...") => {
  if (typeof title !== "string") return fallback;
  const cleaned = title.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  const words = cleaned.split(" ").filter(Boolean);
  if (!words.length) return fallback;
  return words.slice(0, 4).join(" ");
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripAllTempHighlights = (content) => {
  if (!content) return content;
  return content
    .replaceAll(TEMP_HL_END, "")
    .replace(/\[\[\[sel:[^\]]+\]\]\]/g, "");
};

const wrapFirstMatchWithTempHighlight = (content, selectedText, tempId) => {
  if (!content || !selectedText || !tempId) return content;
  const start = `${TEMP_HL_START}${tempId}]]]`;
  const end = TEMP_HL_END;

  const cleaned = stripAllTempHighlights(content);
  const exactIndex = cleaned.indexOf(selectedText);
  if (exactIndex !== -1) {
    return (
      cleaned.slice(0, exactIndex) +
      start +
      cleaned.slice(exactIndex, exactIndex + selectedText.length) +
      end +
      cleaned.slice(exactIndex + selectedText.length)
    );
  }

  const pattern = escapeRegex(selectedText.trim()).replace(/\s+/g, "\\s+");
  try {
    const re = new RegExp(pattern, "m");
    const match = re.exec(cleaned);
    if (!match || match.index == null) return cleaned;
    const matchText = match[0];
    return (
      cleaned.slice(0, match.index) +
      start +
      cleaned.slice(match.index, match.index + matchText.length) +
      end +
      cleaned.slice(match.index + matchText.length)
    );
  } catch {
    return cleaned;
  }
};

const removeTempHighlightById = (content, tempId) => {
  if (!content) return content;
  if (!tempId) return stripAllTempHighlights(content);
  const start = `${TEMP_HL_START}${tempId}]]]`;
  return content.replaceAll(start, "").replaceAll(TEMP_HL_END, "");
};

const convertTempHighlightToBranchHighlight = (
  content,
  tempId,
  highlightId,
  branchNodeId,
) => {
  if (!content || !tempId || !highlightId || !branchNodeId) return content;
  const tempStart = `${TEMP_HL_START}${tempId}]]]`;
  const branchStart = `${BRANCH_HL_START}${highlightId}:${branchNodeId}]]]`;
  return content
    .replaceAll(tempStart, branchStart)
    .replaceAll(TEMP_HL_END, BRANCH_HL_END);
};

const wrapFirstMatchWithBranchHighlight = (
  content,
  selectedText,
  highlightId,
  branchNodeId,
) => {
  if (!content || !selectedText) return content;
  const start = `${BRANCH_HL_START}${highlightId}:${branchNodeId}]]]`;
  const end = BRANCH_HL_END;

  const exactIndex = content.indexOf(selectedText);
  if (exactIndex !== -1) {
    return (
      content.slice(0, exactIndex) +
      start +
      content.slice(exactIndex, exactIndex + selectedText.length) +
      end +
      content.slice(exactIndex + selectedText.length)
    );
  }

  const pattern = escapeRegex(selectedText.trim()).replace(/\s+/g, "\\s+");
  try {
    const re = new RegExp(pattern, "m");
    const match = re.exec(content);
    if (!match || match.index == null) return content;
    const matchText = match[0];
    return (
      content.slice(0, match.index) +
      start +
      content.slice(match.index, match.index + matchText.length) +
      end +
      content.slice(match.index + matchText.length)
    );
  } catch {
    return content;
  }
};

const remarkBranchHighlights = () => {
  const transformNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.children)) {
      const nextChildren = [];
      node.children.forEach((child) => {
        if (child?.type === "text" && typeof child.value === "string") {
          let value = child.value;
          while (true) {
            const branchIdx = value.indexOf(BRANCH_HL_START);
            const tempIdx = value.indexOf(TEMP_HL_START);
            const startIdx =
              branchIdx === -1
                ? tempIdx
                : tempIdx === -1
                  ? branchIdx
                  : Math.min(branchIdx, tempIdx);
            if (startIdx === -1) break;
            const isBranch = startIdx === branchIdx;
            const metaEndIdx = value.indexOf("]]]", startIdx);
            if (metaEndIdx === -1) break;
            const meta = value.slice(
              startIdx + (isBranch ? BRANCH_HL_START.length : TEMP_HL_START.length),
              metaEndIdx,
            );
            const contentStartIdx = metaEndIdx + 3;
            const endIdx = value.indexOf(isBranch ? BRANCH_HL_END : TEMP_HL_END, contentStartIdx);
            if (endIdx === -1) break;

            const before = value.slice(0, startIdx);
            const inside = value.slice(contentStartIdx, endIdx);
            const after = value.slice(
              endIdx + (isBranch ? BRANCH_HL_END.length : TEMP_HL_END.length),
            );

            if (before) nextChildren.push({ type: "text", value: before });
            if (isBranch) {
              const [highlightId, branchNodeId] = meta.split(":");
              if (!highlightId || !branchNodeId) break;
              nextChildren.push({
                type: "link",
                url: `branch-highlight:${highlightId}:${branchNodeId}`,
                children: [{ type: "text", value: inside }],
              });
            } else {
              const tempId = meta;
              if (!tempId) break;
              nextChildren.push({
                type: "link",
                url: `temp-highlight:${tempId}`,
                children: [{ type: "text", value: inside }],
              });
            }

            value = after;
          }

          if (value) {
            nextChildren.push({ ...child, value });
          }
          return;
        }

        transformNode(child);
        nextChildren.push(child);
      });
      node.children = nextChildren;
      return;
    }

    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") transformNode(value);
    });
  };

  return (tree) => {
    transformNode(tree);
  };
};

const remarkLatexDelimiters = () => {
  const normalizeDelimiters = (value) =>
    value
      .replace(/\\\[/g, "$$")
      .replace(/\\\]/g, "$$")
      .replace(/\\\(/g, "$")
      .replace(/\\\)/g, "$");

  const transformNode = (node, inCode = false) => {
    if (!node || typeof node !== "object") return;
    const nextInCode = inCode || node.type === "code" || node.type === "inlineCode";
    if (node.type === "text" && typeof node.value === "string" && !nextInCode) {
      node.value = normalizeDelimiters(node.value);
      return;
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => transformNode(child, nextInCode));
      return;
    }
    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") transformNode(value, nextInCode);
    });
  };

  return (tree) => {
    transformNode(tree);
  };
};

const createRootNode = () => ({
  id: "root",
  parentId: null,
  title: "Root",
  messages: [

  ],
});

const STORAGE_KEY = "chat-trees:v1";

const createTree = (title) => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title,
    nodesById: { root: createRootNode() },
    activeNodeId: "root",
    createdAt: now,
    updatedAt: now,
  };
};

const loadTreesFromStorage = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return null;
    if (!parsed.treesById || typeof parsed.treesById !== "object") return null;
    const treeIds = Object.keys(parsed.treesById);
    if (!treeIds.length) return null;
    const activeTreeId = parsed.activeTreeId && parsed.treesById[parsed.activeTreeId]
      ? parsed.activeTreeId
      : treeIds[0];
    return { treesById: parsed.treesById, activeTreeId };
  } catch {
    return null;
  }
};

const createInitialTreeState = () => {
  const loaded = loadTreesFromStorage();
  if (loaded) return loaded;
  const tree = createTree("New Tree");
  return { treesById: { [tree.id]: tree }, activeTreeId: tree.id };
};

const getSvgViewport = (containerRect, viewBoxWidth, viewBoxHeight) => {
  // Matches preserveAspectRatio="xMidYMin meet"
  const scale = Math.min(
    containerRect.width / viewBoxWidth,
    containerRect.height / viewBoxHeight,
  );
  const offsetX = (containerRect.width - viewBoxWidth * scale) / 2;
  const offsetY = 0;
  return { scale, offsetX, offsetY };
};

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

const truncateForContext = (text, maxChars) => {
  if (typeof text !== "string") return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
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

const buildHiddenContextForNode = (nodeId, nodesById) => {
  const node = nodesById[nodeId];
  if (!node) return "";

  const path = getNodePathToRoot(nodeId, nodesById);
  const breadcrumb = path
    .map((id, index) => {
      const nodeTitle = nodesById[id]?.title;
      if (index === path.length - 1 && id !== "root") {
        return ".";
      }
      return nodeTitle || (id === "root" ? "Root" : null);
    })
    .filter(Boolean)
    .join(" > ");

  const lines = [
    "Hidden context for the assistant (do not repeat verbatim unless asked):",
    breadcrumb ? `Branch path: ${breadcrumb}` : "",
  ].filter(Boolean);

  const excerpt = node?.branchContext?.excerpt;
  if (excerpt) {
    lines.push(`Branch highlight excerpt:\n"""${truncateForContext(excerpt, 1200)}"""`);
  }

  const ancestorIds = path.slice(0, -1);
  if (ancestorIds.length) {
    lines.push("Ancestor snippets (most recent turns):");
    ancestorIds.forEach((id) => {
      const ancestor = nodesById[id];
      if (!ancestor) return;
      const tail = (ancestor.messages || []).slice(-4);
      if (!tail.length) return;
      const snippet = tail
        .map((m) => `${m.role}: ${truncateForContext(m.content ?? "", 220)}`)
        .join("\n");
      lines.push(`- ${ancestor.title}:\n${snippet}`);
    });
  }

  return lines.join("\n\n").trim();
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
  const initialTreeState = useMemo(() => createInitialTreeState(), []);
  const [treesById, setTreesById] = useState(initialTreeState.treesById);
  const [activeTreeId, setActiveTreeId] = useState(initialTreeState.activeTreeId);
  const [hoveredBranchNodeId, setHoveredBranchNodeId] = useState(null);
  const [pendingTeleport, setPendingTeleport] = useState(null);
  const [flashBranchNodeId, setFlashBranchNodeId] = useState(null);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [treeView, setTreeView] = useState("graph");
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [graphScale, setGraphScale] = useState(1.4);
  const [graphTranslate, setGraphTranslate] = useState({ x: 0, y: 0 });
  const [graphHasInteracted, setGraphHasInteracted] = useState(false);
  const [isTreeListCollapsed, setIsTreeListCollapsed] = useState(false);
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const [selectionPopover, setSelectionPopover] = useState({
    visible: false,
    text: "",
    rect: null,
    draft: "",
    placement: "above",
    messageIndex: null,
    nodeId: null,
    treeId: null,
  });
  const [treeMenu, setTreeMenu] = useState({
    visible: false,
    treeId: null,
    rect: null,
    mode: "menu",
    draft: "",
  });
  const [tempHighlight, setTempHighlight] = useState(null);

  const chatAreaRef = useRef(null);
  const inputRef = useRef(null);
  const popoverRef = useRef(null);
  const treeMenuRef = useRef(null);
  const graphContainerRef = useRef(null);
  const sidebarRef = useRef(null);
  const panStateRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    tx: 0,
    ty: 0,
  });
  const resizeStateRef = useRef({
    active: false,
    startX: 0,
    startWidth: 0,
  });

  const activeTree = treesById[activeTreeId];
  const nodesById = activeTree?.nodesById || {};
  const activeNodeId = activeTree?.activeNodeId || "root";
  const activeNode = nodesById[activeNodeId];
  const isEmptyThread = (activeNode?.messages?.length ?? 0) === 0;
  const shouldShowContext = activeNodeId !== "root";
  const parentNodeId = activeNode?.parentId || null;
  const parentNode = parentNodeId ? nodesById[parentNodeId] : null;
  const childrenMap = useMemo(() => buildChildrenMap(nodesById), [nodesById]);
  const treeList = useMemo(
    () => Object.values(treesById).sort((a, b) => a.createdAt - b.createdAt),
    [treesById],
  );
  const visibleTreeList = useMemo(() => {
    if (!isTreeListCollapsed) return treeList;
    return treeList.filter((tree) => tree.id === activeTreeId);
  }, [activeTreeId, isTreeListCollapsed, treeList]);
  const markdownComponents = useMemo(
    () => ({
      a({ href, children, ...props }) {
        if (typeof href === "string" && href.startsWith("temp-highlight:")) {
          const parts = href.split(":");
          const tempId = parts[1];
          return (
            <span
              {...props}
              className="branch-highlight is-temp"
              data-temp-id={tempId}
              aria-hidden="true"
              onMouseDown={(event) => event.preventDefault()}
            >
              {children}
            </span>
          );
        }
        if (typeof href === "string" && href.startsWith("branch-highlight:")) {
          const parts = href.split(":");
          const highlightId = parts[1];
          const branchNodeId = parts[2];
          const disableHoverEffects = selectionPopover.visible;
          const isHovered = !disableHoverEffects && hoveredBranchNodeId === branchNodeId;
          const isTeleportFlash = flashBranchNodeId === branchNodeId;
          return (
            <span
              {...props}
              className={`branch-highlight ${disableHoverEffects ? "no-hover" : ""} ${isHovered ? "is-hovered" : ""
                } ${isTeleportFlash ? "teleport-flash" : ""
                }`}
              data-highlight-id={highlightId}
              data-branch-node-id={branchNodeId}
              role="button"
              tabIndex={0}
              aria-label="Branch highlight"
              onMouseEnter={() => {
                if (disableHoverEffects) return;
                setHoveredBranchNodeId(branchNodeId);
              }}
              onMouseLeave={() => {
                if (disableHoverEffects) return;
                setHoveredBranchNodeId(null);
              }}
              onFocus={() => {
                if (disableHoverEffects) return;
                setHoveredBranchNodeId(branchNodeId);
              }}
              onBlur={() => {
                if (disableHoverEffects) return;
                setHoveredBranchNodeId(null);
              }}
              onMouseDown={(event) => {
                // Avoid creating a new selection while clicking the highlight
                event.preventDefault();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setActiveNodeId(branchNodeId);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setActiveNodeId(branchNodeId);
              }}
            >
              {children}
            </span>
          );
        }
        return (
          <a href={href} {...props}>
            {children}
          </a>
        );
      },
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
    [flashBranchNodeId, hoveredBranchNodeId, selectionPopover.visible],
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

  const updateTree = (treeId, updater) => {
    setTreesById((prev) => {
      const tree = prev[treeId];
      if (!tree) return prev;
      const next = typeof updater === "function" ? updater(tree) : { ...tree, ...updater };
      if (next === tree) return prev;
      return { ...prev, [treeId]: next };
    });
  };

  const updateTreeNodes = (treeId, updater) => {
    setTreesById((prev) => {
      const tree = prev[treeId];
      if (!tree) return prev;
      const nextNodes = typeof updater === "function" ? updater(tree.nodesById) : updater;
      if (nextNodes === tree.nodesById) return prev;
      return {
        ...prev,
        [treeId]: {
          ...tree,
          nodesById: nextNodes,
          updatedAt: Date.now(),
        },
      };
    });
  };

  const updateNodeMessages = (treeId, nodeId, updater) => {
    updateTreeNodes(treeId, (prevNodes) => {
      const node = prevNodes[nodeId];
      if (!node) return prevNodes;
      return {
        ...prevNodes,
        [nodeId]: {
          ...node,
          messages: updater(node.messages),
        },
      };
    });
  };

  const updateNode = (treeId, nodeId, updater) => {
    updateTreeNodes(treeId, (prevNodes) => {
      const node = prevNodes[nodeId];
      if (!node) return prevNodes;
      const next = typeof updater === "function" ? updater(node) : { ...node, ...updater };
      if (next === node) return prevNodes;
      return { ...prevNodes, [nodeId]: next };
    });
  };

  const setActiveNodeId = (nodeId) => {
    updateTree(activeTreeId, (tree) => ({ ...tree, activeNodeId: nodeId }));
  };

  const teleportToParentHighlight = () => {
    if (!parentNodeId) return;
    setPendingTeleport({ parentNodeId, childNodeId: activeNodeId });
    setActiveNodeId(parentNodeId);
  };

  const createNewTree = () => {
    const tree = createTree("New Tree");
    setTreesById((prev) => ({ ...prev, [tree.id]: tree }));
    setActiveTreeId(tree.id);
    setTreeView("graph");
  };

  const closeTreeMenu = () => {
    setTreeMenu({
      visible: false,
      treeId: null,
      rect: null,
      mode: "menu",
      draft: "",
    });
  };

  const openTreeMenu = (treeId, event) => {
    event.preventDefault();
    event.stopPropagation();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const left = Math.min(buttonRect.left, window.innerWidth - 260);
    setTreeMenu({
      visible: true,
      treeId,
      rect: { top: buttonRect.bottom + 8, left },
      mode: "menu",
      draft: treesById[treeId]?.title ?? "",
    });
  };

  const deleteTree = (treeId) => {
    const tree = treesById[treeId];
    if (!tree) return;
    const ok = window.confirm(`Delete "${tree.title}"? This cannot be undone.`);
    if (!ok) return;

    const remaining = treeList.filter((t) => t.id !== treeId);

    // Important: never leave `activeTreeId` as null even briefly; the render path assumes
    // an active tree exists and will crash (black screen) otherwise.
    if (!remaining.length) {
      const fresh = createTree("New Tree");
      setTreesById({ [fresh.id]: fresh });
      setActiveTreeId(fresh.id);
      setTreeView("graph");
    } else {
      setTreesById((prev) => {
        const next = { ...prev };
        delete next[treeId];
        return next;
      });
      if (activeTreeId === treeId) {
        setActiveTreeId(remaining[0].id);
      }
    }

    closeTreeMenu();
  };

  const requestTreeTitle = async (userMessage, assistantMessage = "") => {
    const prompt = [
      "Generate a concise 2-5 word title for this conversation.",
      "Return only the title, no quotes or punctuation.",
      "",
      `User: ${truncateForContext(userMessage, 300)}`,
      assistantMessage ? `Assistant: ${truncateForContext(assistantMessage, 360)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return sendToOpenAI([{ role: "user", content: prompt }]);
  };

  useLayoutEffect(() => {
    if (treeView !== "graph" || graphHasInteracted) return;
    const container = graphContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const rootPos = graphLayout.positions.root;
    if (!rootPos) return;
    const nodeRadiusUser = 34;
    const paddingPx = 12;
    const { scale: s, offsetX, offsetY } = getSvgViewport(
      rect,
      graphLayout.width,
      graphLayout.height,
    );
    const targetXUser = (rect.width / 2 - offsetX) / s;
    const targetYUser = (paddingPx - offsetY) / s + nodeRadiusUser * graphScale;
    setGraphTranslate({
      x: targetXUser - rootPos.x * graphScale,
      y: targetYUser - rootPos.y * graphScale,
    });
  }, [treeView, graphLayout, graphScale, graphHasInteracted, sidebarWidth]);

  useClickOutside(popoverRef, () => {
    if (selectionPopover.visible) {
      setSelectionPopover({
        visible: false,
        text: "",
        rect: null,
        draft: "",
        placement: "above",
        messageIndex: null,
        nodeId: null,
        treeId: null,
      });
    }
    if (tempHighlight) {
      updateNodeMessages(tempHighlight.treeId, tempHighlight.nodeId, (messages) =>
        messages.map((m, i) => {
          if (i !== tempHighlight.messageIndex || typeof m?.content !== "string") return m;
          return { ...m, content: removeTempHighlightById(m.content, tempHighlight.tempId) };
        }),
      );
      setTempHighlight(null);
    }
  });

  useClickOutside(treeMenuRef, () => {
    if (treeMenu.visible) closeTreeMenu();
  });

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Shift") {
        const payload = getSelectionPayload();
        if (payload) {
          setSelectionPopover({
            visible: true,
            text: payload.text,
            rect: payload.rect,
            draft: "",
            placement: payload.placement,
            messageIndex: payload.messageIndex,
            nodeId: activeNodeId,
            treeId: activeTreeId,
          });
        }
        return;
      }
      if (event.key !== "Escape") return;
      window.getSelection()?.removeAllRanges?.();
      if (selectionPopover.visible) {
        setSelectionPopover({
          visible: false,
          text: "",
          rect: null,
          draft: "",
          placement: "above",
          messageIndex: null,
          nodeId: null,
          treeId: null,
        });
      }
      if (tempHighlight) {
        updateNodeMessages(tempHighlight.treeId, tempHighlight.nodeId, (messages) =>
          messages.map((m, i) => {
            if (i !== tempHighlight.messageIndex || typeof m?.content !== "string") return m;
            return { ...m, content: removeTempHighlightById(m.content, tempHighlight.tempId) };
          }),
        );
        setTempHighlight(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectionPopover.visible, activeNodeId, activeTreeId, tempHighlight]);

  useEffect(() => {
    if (activeTreeId) return;
    if (!treeList.length) return;
    setActiveTreeId(treeList[0].id);
  }, [activeTreeId, treeList]);

  useEffect(() => {
    if (!activeTreeId) return;
    if (tempHighlight) {
      updateNodeMessages(tempHighlight.treeId, tempHighlight.nodeId, (messages) =>
        messages.map((m, i) => {
          if (i !== tempHighlight.messageIndex || typeof m?.content !== "string") return m;
          return {
            ...m,
            content: removeTempHighlightById(m.content, tempHighlight.tempId),
          };
        }),
      );
    }
    setTempHighlight(null);
    setSelectionPopover({
      visible: false,
      text: "",
      rect: null,
      draft: "",
      placement: "above",
      messageIndex: null,
      nodeId: null,
      treeId: null,
    });
    setHoveredBranchNodeId(null);
    setDraft("");
    setError("");
  }, [activeTreeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      version: 1,
      treesById,
      activeTreeId,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [treesById, activeTreeId]);

  useEffect(() => {
    if (!selectionPopover.visible) return;
    if (!selectionPopover.text?.trim()) return;
    if (selectionPopover.messageIndex == null) return;
    if (!selectionPopover.nodeId) return;
    if (!selectionPopover.treeId) return;

    if (tempHighlight) {
      updateNodeMessages(tempHighlight.treeId, tempHighlight.nodeId, (messages) =>
        messages.map((m, i) => {
          if (i !== tempHighlight.messageIndex || typeof m?.content !== "string") return m;
          return { ...m, content: removeTempHighlightById(m.content, tempHighlight.tempId) };
        }),
      );
    }

    const tempId = crypto.randomUUID();
    const nodeId = selectionPopover.nodeId;
    const msgIdx = selectionPopover.messageIndex;
    updateNodeMessages(selectionPopover.treeId, nodeId, (messages) =>
      messages.map((m, i) => {
        if (i !== msgIdx || typeof m?.content !== "string") return m;
        return {
          ...m,
          content: wrapFirstMatchWithTempHighlight(m.content, selectionPopover.text, tempId),
        };
      }),
    );
    setTempHighlight({
      nodeId,
      messageIndex: msgIdx,
      tempId,
      treeId: selectionPopover.treeId,
    });
    window.getSelection()?.removeAllRanges?.();
  }, [
    selectionPopover.visible,
    selectionPopover.text,
    selectionPopover.messageIndex,
    selectionPopover.nodeId,
    selectionPopover.treeId,
  ]);

  useEffect(() => {
    if (!shouldShowContext && isContextModalOpen) {
      setIsContextModalOpen(false);
    }
  }, [shouldShowContext, isContextModalOpen]);

  useEffect(() => {
    if (!activeTreeId) return;
    updateNode(activeTreeId, activeNodeId, (node) => {
      if (!node?.hasUnread) return node;
      return {
        ...node,
        hasUnread: false,
        requestStatus: node.requestStatus === "ready" ? "idle" : node.requestStatus,
      };
    });
  }, [activeTreeId, activeNodeId]);

  const addNode = (treeId, parentId, title, messages, extra = {}, options = {}) => {
    const id = crypto.randomUUID();
    const shouldActivate = options.activate !== false;
    updateTreeNodes(treeId, (prev) => ({
      ...prev,
      [id]: {
        id,
        parentId,
        title,
        messages,
        ...extra,
      },
    }));
    if (shouldActivate) {
      updateTree(treeId, (tree) => ({ ...tree, activeNodeId: id }));
    }
    return id;
  };

  const sendToOpenAI = async (messages, hiddenContext = "") => {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing VITE_OPENAI_API_KEY in .env");
    }
    const systemMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    if (hiddenContext && hiddenContext.trim()) {
      systemMessages.push({ role: "system", content: hiddenContext.trim() });
    }
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [...systemMessages, ...messages],
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

  const requestBranchTitle = async (userMessage, branchExcerpt) => {
    const prompt = [
      "Generate a concise 2-4 word title for this branch request.",
      "Return only the title, no quotes or punctuation.",
      "",
      `User request: ${truncateForContext(userMessage, 240)}`,
      branchExcerpt
        ? `Selected excerpt: ${truncateForContext(branchExcerpt, 240)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return sendToOpenAI([{ role: "user", content: prompt }]);
  };

  const handleSend = async (content) => {
    if (!content.trim() || isLoading) return;
    if (!activeTreeId) return;
    setError("");
    const trimmed = content.trim();
    const nodeSnapshot = nodesById[activeNodeId];
    const treeIdSnapshot = activeTreeId;
    const treeSnapshot = treesById[treeIdSnapshot];
    const isFirstRootTurn =
      activeNodeId === "root" && (nodeSnapshot?.messages?.length ?? 0) === 0;
    const hiddenContext = shouldShowContext
      ? buildHiddenContextForNode(activeNodeId, nodesById)
      : "";
    updateNodeMessages(activeTreeId, activeNodeId, (messages) => [
      ...messages,
      { role: "user", content: trimmed },
    ]);

    const shouldAutoTitle =
      isFirstRootTurn &&
      treeSnapshot &&
      (treeSnapshot.title === "New Tree" ||
        treeSnapshot.title === "New tree" ||
        /^Tree \d+$/.test(treeSnapshot.title));

    setDraft("");
    setIsLoading(true);
    try {
      const replyPromise = sendToOpenAI(
        [...(nodeSnapshot?.messages ?? []), { role: "user", content: trimmed }],
        hiddenContext,
      );

      // Fire this in parallel with the main reply request so it can return ASAP.
      if (shouldAutoTitle) {
        requestTreeTitle(trimmed, "")
          .then((title) => {
            const nextTitle = normalizeGeneratedTitle(title, "New Tree");
            updateTree(treeIdSnapshot, (tree) => {
              if (!tree) return tree;
              // Don't override if the user renamed it in the meantime.
              if (
                tree.title !== "New Tree" &&
                tree.title !== "New tree" &&
                !/^Tree \d+$/.test(tree.title)
              )
                return tree;
              return { ...tree, title: nextTitle };
            });
          })
          .catch(() => { });
      }

      const reply = await replyPromise;
      updateNodeMessages(activeTreeId, activeNodeId, (messages) => [
        ...messages,
        { role: "assistant", content: reply || "No response returned." },
      ]);
    } catch (err) {
      setError(err.message || "Failed to reach OpenAI.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleComposerKeyDown = (event) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    event.preventDefault();
    handleSend(draft);
  };

  const handleBranchKeyDown = (event) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    event.preventDefault();
    handleBranchSend();
  };

  const handleBranchSend = async () => {
    if (!selectionPopover.text.trim() || !selectionPopover.draft.trim()) {
      return;
    }
    setError("");
    const treeId = selectionPopover.treeId || activeTreeId;
    if (!treeId) return;
    const sourceNodeId = selectionPopover.nodeId || activeNodeId;
    const userMessage = selectionPopover.draft.trim();
    const fallbackTitle = "...";
    const branchExcerpt = selectionPopover.text.trim();
    const newNodeId = addNode(
      treeId,
      sourceNodeId,
      fallbackTitle,
      [{ role: "user", content: userMessage }],
      {
        branchContext: {
          excerpt: branchExcerpt,
          sourceNodeId,
          createdAt: Date.now(),
        },
        requestStatus: "pending",
        hasUnread: false,
      },
      { activate: false },
    );
    const highlightId = crypto.randomUUID();
    if (tempHighlight && tempHighlight.nodeId === sourceNodeId && tempHighlight.treeId === treeId) {
      updateNodeMessages(treeId, sourceNodeId, (messages) =>
        messages.map((m, i) => {
          if (i !== tempHighlight.messageIndex || typeof m?.content !== "string") return m;
          return {
            ...m,
            content: convertTempHighlightToBranchHighlight(
              m.content,
              tempHighlight.tempId,
              highlightId,
              newNodeId,
            ),
          };
        }),
      );
      setTempHighlight(null);
    } else if (selectionPopover.messageIndex != null) {
      updateNodeMessages(treeId, sourceNodeId, (messages) =>
        messages.map((m, i) => {
          if (i !== selectionPopover.messageIndex || typeof m?.content !== "string") return m;
          return {
            ...m,
            content: wrapFirstMatchWithBranchHighlight(
              m.content,
              selectionPopover.text,
              highlightId,
              newNodeId,
            ),
          };
        }),
      );
    }
    setSelectionPopover({
      visible: false,
      text: "",
      rect: null,
      draft: "",
      placement: "above",
      messageIndex: null,
      nodeId: null,
      treeId: null,
    });
    window.getSelection()?.removeAllRanges?.();
    try {
      // Build context against a snapshot that includes the new node (setState is async).
      const treeSnapshot = treesById[treeId];
      const baseNodes = treeSnapshot?.nodesById || nodesById;
      const nodesWithNew = {
        ...baseNodes,
        [newNodeId]: {
          id: newNodeId,
          parentId: sourceNodeId,
          title: fallbackTitle,
          messages: [{ role: "user", content: userMessage }],
          branchContext: {
            excerpt: branchExcerpt,
            sourceNodeId,
            createdAt: Date.now(),
          },
          requestStatus: "pending",
          hasUnread: false,
        },
      };
      const hiddenContext = buildHiddenContextForNode(newNodeId, nodesWithNew);
      const replyPromise = sendToOpenAI([{ role: "user", content: userMessage }], hiddenContext);
      const titlePromise = requestBranchTitle(userMessage, branchExcerpt);
      titlePromise
        .then((title) => {
          const nextTitle = normalizeGeneratedTitle(title, fallbackTitle);
          updateNode(treeId, newNodeId, (node) => ({ ...node, title: nextTitle }));
        })
        .catch(() => { });

      const reply = await replyPromise;
      updateNodeMessages(treeId, newNodeId, (messages) => [
        ...messages,
        { role: "assistant", content: reply || "No response returned." },
      ]);
      updateNode(treeId, newNodeId, (node) => ({
        ...node,
        requestStatus: "ready",
        hasUnread: true,
      }));
    } catch (err) {
      setError(err.message || "Failed to reach OpenAI.");
      updateNode(treeId, newNodeId, (node) => ({
        ...node,
        requestStatus: "idle",
      }));
    }
  };

  const getSelectionPayload = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      !chatAreaRef.current ||
      !chatAreaRef.current.contains(anchorNode) ||
      !chatAreaRef.current.contains(focusNode)
    ) {
      return null;
    }
    const text = selection.toString().trim();
    if (!text) return null;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const placement = rect.top > 220 ? "above" : "below";
    const top = placement === "above" ? rect.top - 8 : rect.bottom + 8;
    const left = Math.min(rect.left, window.innerWidth - 320);

    const startContainer =
      range.startContainer?.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : range.startContainer;
    const messageEl = startContainer?.closest?.(".message");
    const messageIndexRaw = messageEl?.dataset?.messageIndex;
    const messageIndex =
      messageIndexRaw != null && messageIndexRaw !== ""
        ? Number(messageIndexRaw)
        : null;

    return {
      text,
      rect: { top, left },
      placement,
      messageIndex: Number.isFinite(messageIndex) ? messageIndex : null,
    };
  };

  const handleSelection = (event) => {
    const payload = getSelectionPayload();
    if (!payload) {
      if (selectionPopover.visible) {
        setSelectionPopover({
          visible: false,
          text: "",
          rect: null,
          draft: "",
          placement: "above",
          messageIndex: null,
          nodeId: null,
          treeId: null,
        });
      }
      return;
    }

    if (!event?.shiftKey) {
      if (selectionPopover.visible) {
        setSelectionPopover({
          visible: false,
          text: "",
          rect: null,
          draft: "",
          placement: "above",
          messageIndex: null,
          nodeId: null,
          treeId: null,
        });
      }
      return;
    }

    setSelectionPopover({
      visible: true,
      text: payload.text,
      rect: payload.rect,
      draft: "",
      placement: payload.placement,
      messageIndex: payload.messageIndex,
      nodeId: activeNodeId,
      treeId: activeTreeId,
    });
  };

  const renderTree = (nodeId, depth = 0) => {
    const node = nodesById[nodeId];
    const children = childrenMap[nodeId] || [];
    const isPending = node?.requestStatus === "pending";
    const isReady = node?.hasUnread;
    return (
      <div key={nodeId}>
        <button
          className={`tree-item ${activeNodeId === nodeId ? "active" : ""} ${hoveredBranchNodeId === nodeId ? "branch-hover" : ""
            }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => setActiveNodeId(nodeId)}
          onMouseEnter={() => setHoveredBranchNodeId(nodeId)}
          onMouseLeave={() => setHoveredBranchNodeId(null)}
          type="button"
        >
          <span className="tree-item-label">
            <span className="tree-title">{node.title}</span>
            {isPending && <span className="tree-badge pending">Pending</span>}
            {!isPending && isReady && <span className="tree-badge ready">Ready</span>}
          </span>
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

  useEffect(() => {
    const handleMove = (event) => {
      if (panStateRef.current.active) {
        const container = graphContainerRef.current;
        if (!container) return;
        const dx = event.clientX - panStateRef.current.startX;
        const dy = event.clientY - panStateRef.current.startY;
        const s = panStateRef.current.viewportScale || 1;
        setGraphTranslate({
          x: panStateRef.current.tx + dx / s,
          y: panStateRef.current.ty + dy / s,
        });
        return;
      }
      if (resizeStateRef.current.active) {
        const dx = event.clientX - resizeStateRef.current.startX;
        const nextWidth = Math.min(
          Math.max(resizeStateRef.current.startWidth + dx, 240),
          520,
        );
        setSidebarWidth(nextWidth);
      }
    };

    const handleUp = () => {
      panStateRef.current.active = false;
      resizeStateRef.current.active = false;
      document.body.classList.remove("is-resizing");
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [sidebarWidth]);

  useLayoutEffect(() => {
    if (!pendingTeleport) return;
    if (activeNodeId !== pendingTeleport.parentNodeId) return;

    const container = chatAreaRef.current;
    if (!container) {
      setPendingTeleport(null);
      return;
    }

    // Wait a frame so the parent node messages/highlights are in the DOM.
    const raf = window.requestAnimationFrame(() => {
      const selector = `[data-branch-node-id="${pendingTeleport.childNodeId}"]`;
      const highlightEl = container.querySelector(selector);
      if (highlightEl) {
        highlightEl.scrollIntoView({ behavior: "smooth", block: "center" });
        setFlashBranchNodeId(pendingTeleport.childNodeId);
        window.setTimeout(() => {
          setFlashBranchNodeId(null);
        }, 1200);
      }
      setPendingTeleport(null);
    });

    return () => window.cancelAnimationFrame(raf);
  }, [activeNodeId, pendingTeleport]);

  const handleGraphWheel = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const container = graphContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const { scale: s, offsetX, offsetY } = getSvgViewport(
      rect,
      graphLayout.width,
      graphLayout.height,
    );
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    const nextScale = Math.min(Math.max(graphScale * delta, 0.6), 3.2);
    const pointerX = (event.clientX - rect.left - offsetX) / s;
    const pointerY = (event.clientY - rect.top - offsetY) / s;
    const graphX = (pointerX - graphTranslate.x) / graphScale;
    const graphY = (pointerY - graphTranslate.y) / graphScale;
    setGraphScale(nextScale);
    setGraphTranslate({
      x: pointerX - graphX * nextScale,
      y: pointerY - graphY * nextScale,
    });
    setGraphHasInteracted(true);
  };

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const handleWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
    };
    sidebar.addEventListener("wheel", handleWheel, { passive: false });
    return () => sidebar.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const handleWindowWheel = (event) => {
      if (!event.ctrlKey) return;
      const sidebar = sidebarRef.current;
      if (!sidebar) return;
      if (!sidebar.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("wheel", handleWindowWheel, {
      passive: false,
      capture: true,
    });
    return () => {
      window.removeEventListener("wheel", handleWindowWheel, {
        capture: true,
      });
    };
  }, []);

  const handleGraphMouseDown = (event) => {
    if (event.button !== 0) return;
    const container = graphContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const { scale: s } = getSvgViewport(rect, graphLayout.width, graphLayout.height);
    panStateRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      tx: graphTranslate.x,
      ty: graphTranslate.y,
      viewportScale: s,
    };
    setGraphHasInteracted(true);
  };

  const handleResizerMouseDown = (event) => {
    event.preventDefault();
    resizeStateRef.current = {
      active: true,
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    document.body.classList.add("is-resizing");
  };

  return (
    <div className="app">
      <aside
        className="sidebar"
        style={{ width: `${sidebarWidth}px` }}
        ref={sidebarRef}
      >
        <div className="sidebar-header">
          <div className="sidebar-title-row">
            <div>
              <h1>Chat Tree</h1>
              <p >
                {treeList.length} {treeList.length === 1 ? "tree" : "trees"}
              </p>
            </div>
            <div className="sidebar-actions">
              <button
                type="button"
                className="collapse-tree-button"
                onClick={() => setIsTreeListCollapsed((prev) => !prev)}
                title={isTreeListCollapsed ? "Show all trees" : "Show only active tree"}
              >
                {isTreeListCollapsed ? "Show all" : "Only active"}
              </button>
              <button
                type="button"
                className="new-tree-button"
                onClick={createNewTree}
              >
                New tree
              </button>
            </div>
          </div>
          <div className="tree-list">
            {visibleTreeList.map((tree) => {
              const nodeCount = Object.keys(tree.nodesById || {}).length;
              const isActive = tree.id === activeTreeId;
              return (
                <div
                  key={tree.id}
                  className={`tree-switch-row ${isActive ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="tree-switch"
                    onClick={() => setActiveTreeId(tree.id)}
                  >
                    <span className="tree-switch-title">{tree.title}</span>
                  </button>
                  <div className="tree-switch-actions">
                    <button
                      type="button"
                      className="tree-actions-button"
                      aria-label="Tree options"
                      title="Options"
                      onClick={(e) => openTreeMenu(tree.id, e)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="6" cy="12" r="1.8" />
                        <circle cx="12" cy="12" r="1.8" />
                        <circle cx="18" cy="12" r="1.8" />
                      </svg>
                    </button>
                    <span className="tree-switch-meta">
                      {nodeCount} {nodeCount === 1 ? "node" : "nodes"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

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
          <div
            className="tree-graph"
            ref={graphContainerRef}
            onWheel={handleGraphWheel}
            onMouseDown={handleGraphMouseDown}
          >
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${graphLayout.width} ${graphLayout.height}`}
              preserveAspectRatio="xMidYMin meet"
            >
              <g
                transform={`translate(${graphTranslate.x} ${graphTranslate.y}) scale(${graphScale})`}
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
                  if (!node) return null;
                  const words = (node.title || "").split(" ").filter(Boolean);
                  const isPending = node?.requestStatus === "pending";
                  const isReady = node?.hasUnread;
                  return (
                    <g
                      key={nodeId}
                      className={`graph-node ${nodeId === activeNodeId ? "active" : ""
                        } ${hoveredBranchNodeId === nodeId ? "branch-hover" : ""}`}
                      onClick={() => setActiveNodeId(nodeId)}
                      onMouseEnter={() => setHoveredBranchNodeId(nodeId)}
                      onMouseLeave={() => setHoveredBranchNodeId(null)}
                    >
                      <circle cx={pos.x} cy={pos.y} r="34" />
                      {isPending && (
                        <circle
                          className="graph-node-badge pending"
                          cx={pos.x + 22}
                          cy={pos.y - 22}
                          r="6"
                        />
                      )}
                      {!isPending && isReady && (
                        <circle
                          className="graph-node-badge ready"
                          cx={pos.x + 22}
                          cy={pos.y - 22}
                          r="6"
                        />
                      )}
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
              </g>
            </svg>
          </div>
        ) : (
          <div className="tree">{renderTree("root")}</div>
        )}
      </aside>
      <div className="sidebar-resizer" onMouseDown={handleResizerMouseDown} />
      <main className="chat">
        <div className="chat-frame">
          {isEmptyThread ? (
            <div className="chat-empty">
              <h1 className="chat-empty-title">Where should we begin?</h1>
              {error && <div className="error-banner">{error}</div>}
              <div className="chat-input chat-input--empty">
                <div className="composer">
                  <textarea
                    ref={inputRef}
                    placeholder="Ask anything"
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      resizeInput(event.target);
                    }}
                    onKeyDown={handleComposerKeyDown}
                    rows={2}
                  />
                  <button
                    type="button"
                    className="send-button"
                    onClick={() => handleSend(draft)}
                    disabled={isLoading || !draft.trim()}
                    aria-label="Send message"
                    title="Send"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M22 2L11 13" />
                      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <header className="chat-header">
                <div>
                  <h2>{activeNode?.title ?? "Root"}</h2>
                  <div className="chat-subhead">
                    <span className="chat-meta">
                      {activeNode.messages.length} messages
                    </span>
                    {parentNodeId && parentNode && (
                      <button
                        type="button"
                        className="teleport-button"
                        onClick={teleportToParentHighlight}
                        title={`Jump back to the highlight in "${parentNode.title}" that created this branch`}
                        aria-label="Jump to parent highlight"
                      >
                        <span className="teleport-button-label">
                          Jump to parent highlight
                        </span>
                        <span className="teleport-button-parent">
                          {parentNode.title}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
                {shouldShowContext && (
                  <div className="chat-header-actions">
                    <button
                      type="button"
                      className="context-button"
                      onClick={() => setIsContextModalOpen(true)}
                      aria-label="View AI context"
                      title="View AI context"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 10.5v6" />
                        <path d="M12 7.2h.01" />
                      </svg>
                    </button>
                  </div>
                )}
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
                    data-message-index={index}
                  >
                    <div className="message-role">
                      {message.role === "user" ? "You" : "Assistant"}
                    </div>
                    <div className="message-content">
                      <ReactMarkdown
                        remarkPlugins={[
                          remarkBranchHighlights,
                          remarkLatexDelimiters,
                          remarkGfm,
                          remarkMath,
                          remarkBreaks,
                        ]}
                        rehypePlugins={[rehypeKatex]}
                        urlTransform={(url) => url}
                        components={markdownComponents}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="message assistant message--thinking">
                    <div className="message-role">Assistant</div>
                    <div className="message-content">
                      <span className="thinking">Thinking...</span>
                    </div>
                  </div>
                )}
                {error && <div className="error-banner">{error}</div>}
              </section>
              <footer className="chat-input">
                <div className="composer">
                  <textarea
                    ref={inputRef}
                    placeholder="Ask anything"
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      resizeInput(event.target);
                    }}
                    onKeyDown={handleComposerKeyDown}
                    rows={3}
                  />
                  <button
                    type="button"
                    className="send-button"
                    onClick={() => handleSend(draft)}
                    disabled={isLoading || !draft.trim()}
                    aria-label="Send message"
                    title="Send"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M22 2L11 13" />
                      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                  </button>
                </div>
              </footer>
            </>
          )}
        </div>
      </main>
      {shouldShowContext && isContextModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="AI context"
          onClick={() => setIsContextModalOpen(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">AI context</div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setIsContextModalOpen(false)}
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <pre className="context-preview">
                {buildHiddenContextForNode(activeNodeId, nodesById) || "No context."}
              </pre>
            </div>
          </div>
        </div>
      )}
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
          <div className="selection-title">New branch</div>
          <textarea
            placeholder="Ask anything about selection"
            value={selectionPopover.draft}
            onChange={(event) =>
              setSelectionPopover((prev) => ({
                ...prev,
                draft: event.target.value,
              }))
            }
            onKeyDown={handleBranchKeyDown}
            rows={3}
          />
          <div className="selection-actions">
            <button
              type="button"
              onClick={() => {
                setSelectionPopover({
                  visible: false,
                  text: "",
                  rect: null,
                  draft: "",
                  placement: "above",
                  messageIndex: null,
                  nodeId: null,
                  treeId: null,
                });
                if (tempHighlight) {
                  updateNodeMessages(tempHighlight.treeId, tempHighlight.nodeId, (messages) =>
                    messages.map((m, i) => {
                      if (i !== tempHighlight.messageIndex || typeof m?.content !== "string") return m;
                      return {
                        ...m,
                        content: removeTempHighlightById(m.content, tempHighlight.tempId),
                      };
                    }),
                  );
                  setTempHighlight(null);
                }
                window.getSelection()?.removeAllRanges?.();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleBranchSend}
              disabled={!selectionPopover.draft.trim()}
            >
              Create branch
            </button>
          </div>
        </div>
      )}
      {treeMenu.visible && treeMenu.rect && treeMenu.treeId && (
        <div
          ref={treeMenuRef}
          className="tree-menu-popover"
          style={{
            top: `${treeMenu.rect.top}px`,
            left: `${treeMenu.rect.left}px`,
          }}
          role="dialog"
          aria-label="Tree options"
        >
          {treeMenu.mode === "rename" ? (
            <>
              <div className="tree-menu-title">Rename tree</div>
              <input
                className="tree-menu-input"
                value={treeMenu.draft}
                onChange={(e) =>
                  setTreeMenu((prev) => ({ ...prev, draft: e.target.value }))
                }
                placeholder="Tree name"
                autoFocus
              />
              <div className="tree-menu-actions">
                <button type="button" onClick={closeTreeMenu}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const nextTitle = (treeMenu.draft || "").trim();
                    if (!nextTitle) return;
                    updateTree(treeMenu.treeId, (tree) => ({
                      ...tree,
                      title: nextTitle,
                      updatedAt: Date.now(),
                    }));
                    closeTreeMenu();
                  }}
                  disabled={!treeMenu.draft.trim()}
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="tree-menu-item"
                onClick={() =>
                  setTreeMenu((prev) => ({
                    ...prev,
                    mode: "rename",
                    draft: treesById[prev.treeId]?.title ?? prev.draft ?? "",
                  }))
                }
              >
                Rename
              </button>
              <button
                type="button"
                className="tree-menu-item danger"
                onClick={() => deleteTree(treeMenu.treeId)}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default App;

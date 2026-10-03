"use client";

import { type PointerEvent, useRef, useState } from "react";

const VIEW_W = 380;
const VIEW_H = 210;
const NODE_HEADER_H = 22;
const NODE_BODY_FILL = "#14121F";
const NODE_STROKE = "rgba(255,255,255,0.16)";
/** Wires and the ports they land on share one colour, as in the editor. */
const NODE_WIRE = "#3FB950";
/** The effect's output runs off towards the next stage, which is not drawn. */
const OUTPUT_STUB = 34;

export type GraphNodeKey = "shape" | "random" | "effect";

type NodeSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  accent: string;
  /** Port offsets from the top of the node while it is expanded. */
  inputs: number[];
  outputs: number[];
};

const NODES: Record<GraphNodeKey, NodeSpec> = {
  shape: {
    x: 14,
    y: 22,
    width: 112,
    height: 50,
    accent: "#2EA043",
    inputs: [],
    outputs: [36],
  },
  random: {
    x: 14,
    y: 134,
    width: 112,
    height: 50,
    accent: "#0D9488",
    inputs: [],
    outputs: [36],
  },
  effect: {
    x: 214,
    y: 70,
    width: 124,
    height: 63,
    accent: "#0284C7",
    inputs: [33, 51],
    outputs: [42],
  },
};

const NODE_KEYS = Object.keys(NODES) as GraphNodeKey[];

/** [from node, its output index, to node, its input index] */
const WIRES: [GraphNodeKey, number, GraphNodeKey, number][] = [
  ["shape", 0, "effect", 0],
  ["random", 0, "effect", 1],
];

type NodeState = { x: number; y: number; collapsed: boolean };

const INITIAL_STATE = Object.fromEntries(
  NODE_KEYS.map((key) => [
    key,
    { x: NODES[key].x, y: NODES[key].y, collapsed: false },
  ]),
) as Record<GraphNodeKey, NodeState>;

/** A collapsed node keeps its wires, gathered onto the header like the editor. */
function portY(state: NodeState, offset: number) {
  return state.collapsed ? state.y + NODE_HEADER_H / 2 : state.y + offset;
}

function wirePath(x1: number, y1: number, x2: number, y2: number) {
  const pull = Math.max(24, Math.abs(x2 - x1) * 0.5);
  return `M${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`;
}

type Drag = {
  key: GraphNodeKey;
  pointerId: number;
  startX: number;
  startY: number;
  nodeX: number;
  nodeY: number;
};

/**
 * Nodes are dragged by any part of their body and collapsed with the chevron in
 * the header. Pointer positions are mapped through the SVG's screen matrix, so
 * drags track the cursor at whatever size the panel renders.
 */
export default function NodeGraphMock({
  titles,
  params,
}: {
  titles: Record<GraphNodeKey, string>;
  params: Record<GraphNodeKey, string>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [nodes, setNodes] = useState(INITIAL_STATE);
  /** Paint order: the last node drawn is on top, so a grabbed node moves last. */
  const [order, setOrder] = useState(NODE_KEYS);
  const [dragging, setDragging] = useState<GraphNodeKey | null>(null);

  const toSvg = (clientX: number, clientY: number) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  };

  const onPointerDown = (
    event: PointerEvent<SVGGElement>,
    key: GraphNodeKey,
  ) => {
    if (event.button !== 0) return;
    const point = toSvg(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      nodeX: nodes[key].x,
      nodeY: nodes[key].y,
    };
    setOrder((current) => [...current.filter((k) => k !== key), key]);
    setDragging(key);
  };

  const onPointerMove = (event: PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = toSvg(event.clientX, event.clientY);
    if (!point) return;
    const spec = NODES[drag.key];
    setNodes((current) => {
      const height = current[drag.key].collapsed
        ? NODE_HEADER_H
        : spec.height;
      const x = drag.nodeX + point.x - drag.startX;
      const y = drag.nodeY + point.y - drag.startY;
      return {
        ...current,
        [drag.key]: {
          ...current[drag.key],
          x: Math.min(VIEW_W - spec.width, Math.max(0, x)),
          y: Math.min(VIEW_H - height, Math.max(0, y)),
        },
      };
    });
  };

  const onPointerEnd = (event: PointerEvent<SVGGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(null);
  };

  const toggle = (key: GraphNodeKey) =>
    setNodes((current) => {
      const node = current[key];
      const collapsed = !node.collapsed;
      // A node collapsed near the bottom edge would expand out of view.
      const y = collapsed
        ? node.y
        : Math.min(node.y, VIEW_H - NODES[key].height);
      return { ...current, [key]: { ...node, y, collapsed } };
    });

  const effect = nodes.effect;
  const effectOut = {
    x: effect.x + NODES.effect.width,
    y: portY(effect, NODES.effect.outputs[0]),
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width="100%"
      className="block max-w-full select-none [font-family:inherit]"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="node-graph-grid"
          width="19"
          height="19"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M19 0H0V19"
            fill="none"
            stroke="rgba(255,255,255,0.055)"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width={VIEW_W} height={VIEW_H} fill="url(#node-graph-grid)" />

      {WIRES.map(([from, out, to, input]) => {
        const a = nodes[from];
        const b = nodes[to];
        return (
          <path
            key={`${from}-${to}`}
            d={wirePath(
              a.x + NODES[from].width,
              portY(a, NODES[from].outputs[out]),
              b.x,
              portY(b, NODES[to].inputs[input]),
            )}
            fill="none"
            stroke={NODE_WIRE}
            strokeWidth="2"
          />
        );
      })}
      <path
        d={`M${effectOut.x} ${effectOut.y} L ${effectOut.x + OUTPUT_STUB} ${effectOut.y}`}
        fill="none"
        stroke={NODE_WIRE}
        strokeWidth="2"
      />

      {order.map((key) => (
        <GraphNode
          key={key}
          spec={NODES[key]}
          state={nodes[key]}
          title={titles[key]}
          param={params[key]}
          dragging={dragging === key}
          onPointerDown={(event) => onPointerDown(event, key)}
          onPointerMove={onPointerMove}
          onPointerEnd={onPointerEnd}
          onToggle={() => toggle(key)}
        />
      ))}

    </svg>
  );
}

function GraphNode({
  spec,
  state,
  title,
  param,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onToggle,
}: {
  spec: NodeSpec;
  state: NodeState;
  title: string;
  param: string;
  dragging: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
  onPointerMove: (event: PointerEvent<SVGGElement>) => void;
  onPointerEnd: (event: PointerEvent<SVGGElement>) => void;
  onToggle: () => void;
}) {
  const { x, y, collapsed } = state;
  const { width, accent } = spec;
  const height = collapsed ? NODE_HEADER_H : spec.height;
  const headerMid = y + NODE_HEADER_H / 2;
  const paramY = y + NODE_HEADER_H + (spec.height - NODE_HEADER_H) / 2 + 3.5;
  // Points up while expanded and down while collapsed, as in the editor.
  const chevron = collapsed
    ? `M${x + 8} ${headerMid - 1.25} L${x + 10.5} ${headerMid + 1.25} L${x + 13} ${headerMid - 1.25}`
    : `M${x + 8} ${headerMid + 1.25} L${x + 10.5} ${headerMid - 1.25} L${x + 13} ${headerMid + 1.25}`;

  return (
    <g
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      style={{ touchAction: "none" }}
      className={dragging ? "cursor-grabbing" : "cursor-grab"}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="6"
        fill={NODE_BODY_FILL}
      />
      <rect
        x={x}
        y={y}
        width={width}
        height={NODE_HEADER_H}
        rx="6"
        fill={accent}
      />
      <text
        x={x + 22}
        y={headerMid + 3.4}
        fill="#fff"
        fontSize="9.5"
        fontWeight="700"
      >
        {title}
      </text>
      {!collapsed && (
        <text x={x + 10} y={paramY} fill="#A8A3C6" fontSize="9">
          {param}
        </text>
      )}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="6"
        fill="none"
        stroke={dragging ? "rgba(255,255,255,0.7)" : NODE_STROKE}
      />
      {/* The chevron's hit area is the whole header corner, not the 5px glyph.
          It stops the press reaching the node so a click never starts a drag. */}
      <g
        className="cursor-pointer"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onToggle}
      >
        <rect
          x={x}
          y={y}
          width={20}
          height={NODE_HEADER_H}
          rx="6"
          fill="transparent"
          className="hover:fill-white/15"
        />
        <path
          d={chevron}
          fill="none"
          stroke="#fff"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      </g>
      {/* Ports belong to the node's group so a node dragged over another
          covers its ports too, instead of them showing through on top. */}
      {spec.inputs.map((offset, i) => (
        <circle
          key={`in-${i}`}
          cx={x}
          cy={portY(state, offset)}
          r="3.5"
          fill={NODE_WIRE}
          pointerEvents="none"
        />
      ))}
      {spec.outputs.map((offset, i) => (
        <circle
          key={`out-${i}`}
          cx={x + width}
          cy={portY(state, offset)}
          r="3.5"
          fill={NODE_WIRE}
          pointerEvents="none"
        />
      ))}
    </g>
  );
}

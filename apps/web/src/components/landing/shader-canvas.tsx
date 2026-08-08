"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@beutl/core";

const VERTEX_SOURCE =
  "attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.0,1.0);}";

/*
  The shader palette is derived from the same hex values the rest of the landing
  page uses, rather than hand-converted vec3 literals that drift from them
  silently — a wrong digit here is invisible until someone compares screenshots.
*/
const PALETTE = {
  BG: "#09080F",
  INDIGO: "#6D5CF7",
  CORAL: "#FF7A6B",
  CYAN: "#57D6E6",
} as const;

function toVec3(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    (((value >> shift) & 0xff) / 255).toFixed(3);
  return `vec3(${channel(16)},${channel(8)},${channel(0)})`;
}

const PALETTE_SOURCE = Object.entries(PALETTE)
  .map(([name, hex]) => `const vec3 ${name}=${toVec3(hex)};`)
  .join("");

const FRAGMENT_SOURCE = [
  "precision highp float;",
  "precision highp int;",
  "uniform vec2 u_res;uniform float u_time;uniform int u_from;uniform int u_to;uniform float u_blend;uniform vec2 u_mouse;",
  /*
    Every pattern reads its own clock off T, so TIME_SCALE is the one place that
    sets how fast the backdrop moves as a whole; the patterns keep their
    relative pacing.
  */
  `${PALETTE_SOURCE}const float TAU=6.28318;const float TIME_SCALE=0.6;`,
  "float hash(vec2 p){p=fract(p*vec2(123.34,345.45));p+=dot(p,p+34.345);return fract(p.x*p.y);}",
  "vec2 hash2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453);}",
  "float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);float a=hash(i);float b=hash(i+vec2(1.0,0.0));float c=hash(i+vec2(0.0,1.0));float d=hash(i+vec2(1.0,1.0));return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}",
  "float fbm(vec2 p){float v=0.0;float a=0.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<5;i++){v+=a*noise(p);p=m*p;a*=0.5;}return v;}",
  /*
    The patterns are backdrops for the headline, not the subject. Each one keeps
    its motif but gives up whatever made it read as a demo: accents cover less
    area and stop short of the full palette colour, edges are wide enough to
    have no visible line, and the additive highlights are gone so nothing can
    exceed the copy in contrast.
  */
  "vec3 pAurora(vec2 p,float T){float t=T*0.045;vec2 q=vec2(fbm(p+vec2(0.0,t)),fbm(p+vec2(5.2,1.3)-t*0.8));vec2 r=vec2(fbm(p+1.8*q+vec2(1.7,9.2)),fbm(p+1.8*q+vec2(8.3,2.8)));float f=fbm(p+2.2*r);vec3 col=BG;col=mix(col,mix(BG,INDIGO,0.62),clamp(f*f*1.35,0.0,1.0));col=mix(col,mix(BG,CORAL,0.5),clamp(pow(r.x,2.8)*0.55,0.0,1.0));col=mix(col,mix(BG,CYAN,0.45),clamp(pow(q.y,3.6)*0.3,0.0,1.0));return col;}",
  // A star's halo is now wider than the margin its centre can have inside one
  // cell, so the eight neighbours are sampled too: without them the cell border
  // slices the halo and the particles read as clipped. idc.x wraps at 16 so the
  // seam where the angle comes back around stays continuous.
  "vec3 pStars(vec2 p,float T){float t=T*0.14;vec3 col=BG;float r=length(p)+0.0001;float an=atan(p.y,p.x)/TAU+0.5;for(int k=0;k<2;k++){float fk=float(k);vec2 gv=vec2(an*16.0,log(r)*2.2-t*(1.0+fk*0.5)+fk*10.0);vec2 base=floor(gv);vec2 fc=fract(gv);for(int oy=-1;oy<=1;oy++){for(int ox=-1;ox<=1;ox++){vec2 off=vec2(float(ox),float(oy));vec2 idc=base+off;idc.x=mod(idc.x,16.0);vec2 sp=hash2(idc+fk*3.7)+off;float d=length(fc-sp);float tw=0.78+0.22*sin(t*1.8+hash(idc)*TAU);float star=smoothstep(0.22,0.02,d)*step(0.72,hash(idc+fk));col+=mix(CYAN,INDIGO,hash(idc+7.0))*star*tw*(0.3+0.12*fk);}}}col+=mix(INDIGO,CORAL,0.3)*smoothstep(0.95,0.0,r)*0.07;return col;}",
  "vec3 pGrid(vec2 p,float T){float t=T*0.28;vec3 col=BG;if(p.y>0.0){col=mix(BG,mix(BG,INDIGO,0.34),smoothstep(0.0,1.4,p.y));float glow=smoothstep(1.0,0.0,length(vec2(p.x*0.34,p.y-0.02)));col=mix(col,mix(BG,CORAL,0.4),glow*0.45);}else{float persp=0.18/(-p.y+0.02);float gx=p.x*persp*5.5;float gy=persp*5.5+t*3.0;float dx=0.5-abs(fract(gx)-0.5);float dy=0.5-abs(fract(gy)-0.5);float line=smoothstep(0.1,0.0,min(dx,dy));col=mix(BG,mix(BG,INDIGO,0.45),0.16);col=mix(col,mix(BG,mix(CYAN,INDIGO,0.55),0.7),line*0.34);col*=smoothstep(0.03,-0.6,p.y);}return col;}",
  "vec3 pMeta(vec2 p,float T){float t=T*0.22;float f=0.0;for(int i=0;i<4;i++){float fi=float(i);vec2 c=vec2(sin(t*0.7+fi*1.3)*0.95,cos(t*0.6+fi*2.1)*0.55);float rad=0.26+0.05*sin(t+fi);f+=rad*rad/(dot(p-c,p-c)+0.05);}vec3 col=mix(BG,mix(BG,INDIGO,0.55),smoothstep(0.15,1.45,f));col=mix(col,mix(BG,CORAL,0.42),smoothstep(1.3,2.8,f));return col;}",
  "vec3 pInfinite(vec2 p,float T){float t=T*0.26;float r=length(p)+0.0015;float a=atan(p.y,p.x)+t*0.12;float depth=0.45/r+t;float ang=a/3.14159;float rings=0.5-abs(fract(depth*1.4)-0.5);float spokes=0.5-abs(fract(ang*4.0)-0.5);float line=smoothstep(0.11,0.0,min(rings,spokes));vec3 tint=mix(INDIGO,CYAN,0.5+0.5*sin(depth*1.1));vec3 col=mix(BG,mix(BG,tint,0.2),smoothstep(0.0,1.25,r));col=mix(col,mix(BG,tint,0.62),line*0.45);col=mix(col,mix(BG,INDIGO,0.5),smoothstep(0.4,0.0,r)*0.3);col*=0.6+0.4*smoothstep(1.8,0.1,r);return col;}",
  // The escape radius and the iteration count both widen the lit band, which is
  // what turns the filaments into the busiest frame of the set. They stay at 4
  // and 64, and m*m keeps the tint on the boundary and nothing else.
  "vec3 pJulia(vec2 p,float T){float t=T*0.09;vec2 c=vec2(-0.76,0.15)+0.11*vec2(cos(t),sin(t*1.2));vec2 z=p*1.15;float it=0.0;for(int i=0;i<64;i++){z=vec2(z.x*z.x-z.y*z.y,2.0*z.x*z.y)+c;if(dot(z,z)>4.0)break;it+=1.0;}float m=it/64.0;vec3 col=mix(BG,mix(BG,INDIGO,0.5),m*m);col=mix(col,mix(BG,CYAN,0.3),smoothstep(0.8,1.0,m)*0.25);if(it>=63.5)col=mix(BG,INDIGO,0.16);return col;}",
  "vec3 patternFor(int id,vec2 p,float T){if(id==0)return pAurora(p,T);else if(id==1)return pStars(p,T);else if(id==2)return pGrid(p,T);else if(id==3)return pMeta(p,T);else if(id==4)return pInfinite(p,T);return pJulia(p,T);}",
  "void main(){vec2 p=(gl_FragCoord.xy-0.5*u_res.xy)/u_res.y;p*=1.6;p+=(u_mouse-0.5)*0.05;float T=u_time*TIME_SCALE;vec3 a=patternFor(u_from,p,T);vec3 b=(u_blend>0.001)?patternFor(u_to,p,T):a;vec3 col=mix(a,b,u_blend);col*=0.5+0.5*smoothstep(1.5,0.12,length(p));col+=hash(gl_FragCoord.xy+T)*0.03-0.015;gl_FragColor=vec4(col,1.0);}",
].join("\n");

const PATTERN_COUNT = 6;
const HOLD_SECONDS = 9.5;
const FADE_SECONDS = 3.6;
const MAX_PIXEL_RATIO = 2;

const FALLBACK_BACKGROUND =
  "radial-gradient(60% 80% at 75% 20%, rgba(109,92,247,0.26), transparent 60%), radial-gradient(50% 60% at 15% 85%, rgba(255,122,107,0.15), transparent 60%), #09080F";

type Status = "pending" | "ready" | "unsupported";

export default function ShaderCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>("pending");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let context: WebGLRenderingContext | null = null;
    try {
      context =
        (canvas.getContext("webgl") as WebGLRenderingContext | null) ??
        (canvas.getContext(
          "experimental-webgl",
        ) as WebGLRenderingContext | null);
    } catch {
      context = null;
    }
    if (!context) {
      setStatus("unsupported");
      return;
    }
    const gl = context;

    const compile = (type: number, source: string) => {
      // The reported line numbers refer to the generated source, so log it:
      // the fragment shader's palette is assembled at module load.
      const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
      const shader = gl.createShader(type);
      if (!shader) {
        console.error(`[ShaderCanvas] could not create the ${kind} shader.`);
        return null;
      }
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(
          `[ShaderCanvas] the ${kind} shader failed to compile:\n${gl.getShaderInfoLog(shader)}\n--- source ---\n${source}`,
        );
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    const program = vertexShader && fragmentShader ? gl.createProgram() : null;
    if (!vertexShader || !fragmentShader || !program) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      setStatus("unsupported");
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(
        `[ShaderCanvas] the program failed to link:\n${gl.getProgramInfoLog(program)}`,
      );
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      setStatus("unsupported");
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const positionLocation = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "u_res");
    const uTime = gl.getUniformLocation(program, "u_time");
    const uFrom = gl.getUniformLocation(program, "u_from");
    const uTo = gl.getUniformLocation(program, "u_to");
    const uBlend = gl.getUniformLocation(program, "u_blend");
    const uMouse = gl.getUniformLocation(program, "u_mouse");

    setStatus("ready");

    const mouse: [number, number] = [0.72, 0.4];
    let current = 0;
    let upcoming = 0;
    let blend = 0;
    let transitioning = false;
    let clock = 0;
    let transitionStart = 0;
    let segmentStart = 0;
    let last: number | null = null;
    let frame = 0;

    const smoothstep = (x: number) => x * x * (3 - 2 * x);

    /*
      Reading clientWidth forces a synchronous layout, so it happens only when a
      ResizeObserver says the box actually changed rather than on every frame —
      this page scrolls through fourteen sections that animate as they enter.
    */
    let needsResize = true;
    const resize = () => {
      if (!needsResize) return;
      needsResize = false;
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const width = Math.floor(canvas.clientWidth * ratio);
      const height = Math.floor(canvas.clientHeight * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      gl.uniform2f(uRes, width, height);
    };

    const draw = () => {
      resize();
      gl.uniform1i(uFrom, current);
      gl.uniform1i(uTo, transitioning ? upcoming : current);
      gl.uniform1f(uBlend, transitioning ? blend : 0);
      gl.uniform1f(uTime, clock);
      gl.uniform2f(uMouse, mouse[0], mouse[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (time: number) => {
      if (last === null) last = time;
      const delta = Math.min((time - last) / 1000, 0.1);
      last = time;
      clock += delta;
      if (!transitioning) {
        if (clock - segmentStart >= HOLD_SECONDS) {
          transitioning = true;
          transitionStart = clock;
          upcoming = (current + 1) % PATTERN_COUNT;
        }
      } else {
        const progress = (clock - transitionStart) / FADE_SECONDS;
        if (progress >= 1) {
          current = upcoming;
          transitioning = false;
          segmentStart = clock;
          blend = 0;
        } else {
          blend = smoothstep(progress);
        }
      }
      draw();
      frame = requestAnimationFrame(loop);
    };

    const animates = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;

    let lost = false;

    const start = () => {
      if (frame || !animates || lost) return;
      last = null; // resume from the new timestamp, not the clamped 0.1s jump
      frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const handlePointerMove = (event: PointerEvent) => {
      mouse[0] = event.clientX / window.innerWidth;
      mouse[1] = 1 - event.clientY / window.innerHeight;
    };

    /*
      The hero only occupies the top of the page, so there is no reason to keep
      evaluating a full-screen fragment shader while the reader is further down.
    */
    const visibility = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) start();
      else stop();
    });
    visibility.observe(canvas);

    const sizing = new ResizeObserver(() => {
      if (lost) return; // the fallback hides the canvas, reporting a 0x0 box
      needsResize = true;
      if (!frame) draw(); // keep the static frame in step while paused
    });
    sizing.observe(canvas);

    /*
      A lost context leaves the canvas transparent while status is already
      "ready", so the fallback is gone and the hero reads as a blank panel.
      Drop back to the gradient instead of animating something that draws
      nothing. Losing the context is normal after sleep or a driver reset.
    */
    const handleContextLost = () => {
      // Deliberately not calling preventDefault(). That asks the browser to
      // restore the context, and this component never rebuilds one — it would
      // hold a GPU context nobody draws into, against a per-browser limit that
      // other tabs share.
      lost = true;
      stop();
      console.warn(
        "[ShaderCanvas] WebGL context lost; falling back to the gradient.",
      );
      setStatus("unsupported");
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);

    if (animates) {
      window.addEventListener("pointermove", handlePointerMove, {
        passive: true,
      });
    }
    // Draw before React commits the "ready" state. The fallback is still
    // mounted at this point — setStatus only queues a render — so the canvas
    // already holds a frame the moment the gradient unmounts. Leaving the first
    // paint to the IntersectionObserver would be too late: its callback is
    // asynchronous, so the gradient would go and expose an empty canvas.
    draw();

    return () => {
      stop();
      visibility.disconnect();
      sizing.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      window.removeEventListener("pointermove", handlePointerMove);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <>
      {status !== "ready" && (
        <div
          className="absolute inset-0 z-0"
          style={{ background: FALLBACK_BACKGROUND }}
        />
      )}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={cn(
          "absolute inset-0 z-0 h-full w-full max-w-full",
          status === "unsupported" && "hidden",
        )}
      />
    </>
  );
}

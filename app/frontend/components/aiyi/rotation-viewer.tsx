'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCw } from 'lucide-react';
import styles from './workbench.module.css';

export function RotationViewer({frames, name, immersive = false}: {frames: string[]; name: string; immersive?: boolean}) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{x: number; frame: number; width: number; lastX: number; lastAt: number; velocity: number} | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const inertia = useRef<number | null>(null);
  const [visible,setVisible] = useState(true);
  const [interacting,setInteracting] = useState(false);
  useEffect(()=>{if(!immersive||!stage.current||typeof IntersectionObserver==='undefined')return;const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{threshold:.2});observer.observe(stage.current);return()=>observer.disconnect();},[immersive]);
  useEffect(()=>()=>{if(inertia.current!==null)cancelAnimationFrame(inertia.current);},[]);
  const count = frames.length;
  useEffect(()=>{if(!immersive||!visible||interacting||count<2||failed)return;if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;const timer=window.setTimeout(()=>setPlaying(true),2200);return()=>window.clearTimeout(timer);},[immersive,visible,interacting,count,failed]);
  useEffect(()=>{if(!visible)setPlaying(false);},[visible]);
  useEffect(() => {setFrame(index => Math.min(index, Math.max(0, count - 1))); if (count < 2) setPlaying(false); setFailed(false);}, [count]);
  useEffect(() => {
    if (!playing || count < 2) return;
    const timer = window.setInterval(() => setFrame(index => (index + 1) % count), 80);
    return () => window.clearInterval(timer);
  }, [playing, count]);
  useEffect(() => {
    if (!count) return;
    for (const index of [(frame + 1) % count, (frame + count - 1) % count]) {const image = new Image(); image.src = frames[index];}
  }, [frame, count, frames]);
  function release() {
    const velocity=drag.current?.velocity || 0;drag.current=null;setInteracting(false);
    if(!immersive||Math.abs(velocity)<.2||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    let position=frame,speed=velocity;
    const advance=()=>{position+=speed;speed*=.9;show(Math.round(position));if(Math.abs(speed)>.03)inertia.current=requestAnimationFrame(advance);else inertia.current=null;};inertia.current=requestAnimationFrame(advance);
  }
  function show(index: number) {if (count) setFrame(((index % count) + count) % count); setFailed(false);}
  if (!count) return <p className={styles.error}>这条转身记录还没有可显示的帧图片。</p>;
  return <div className={styles.rotationViewer}>
    <div ref={stage} className={styles.rotationStage} aria-label={`${name}转身画面`} onPointerDown={event => {
      if (event.button !== 0) return;
      setPlaying(false);setInteracting(true);if(inertia.current!==null){cancelAnimationFrame(inertia.current);inertia.current=null;} drag.current = {x: event.clientX, frame, width: Math.max(event.currentTarget.getBoundingClientRect().width, 1),lastX:event.clientX,lastAt:performance.now(),velocity:0};
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }} onPointerMove={event => {if (drag.current) {const now=performance.now();drag.current.velocity=Math.max(-3,Math.min(3,(event.clientX-drag.current.lastX)/drag.current.width*count*16/Math.max(now-drag.current.lastAt,1)));drag.current.lastX=event.clientX;drag.current.lastAt=now;show(drag.current.frame + Math.round((event.clientX - drag.current.x) / drag.current.width * count));}}} onPointerUp={release} onPointerCancel={()=>{drag.current=null;setInteracting(false);}} onLostPointerCapture={()=>{drag.current=null;setInteracting(false);}}>
      <img src={frames[Math.min(frame, count - 1)]} alt={`${name} · 第 ${frame + 1} 帧`} draggable={false} onError={() => {setPlaying(false); setFailed(true);}}/>
    </div>
    <div className={styles.rotationControls}><button type="button" className={styles.secondary} aria-label="上一帧" onClick={() => {setPlaying(false); show(frame - 1);}}><ChevronLeft size={16}/></button><button type="button" className={styles.secondary} disabled={count < 2 || failed} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={15}/> : <Play size={15}/>} {playing ? '暂停转身' : '自动播放'}</button><button type="button" className={styles.secondary} aria-label="下一帧" onClick={() => {setPlaying(false); show(frame + 1);}}><ChevronRight size={16}/></button><span>{frame + 1} / {count} 帧</span></div>
    <label className={styles.rotationSlider}>拖动查看角度<input type="range" min={0} max={count - 1} value={Math.min(frame, count - 1)} aria-label="转身帧位置" onChange={event => {setPlaying(false); show(Number(event.target.value));}}/></label>
    {failed && <p role="alert" className={styles.error}>当前帧加载失败。请刷新这条任务的状态后重试。</p>}
    <p className={styles.small}><RotateCw size={13}/> 左右拖动画面，或使用滑条和方向按钮。这里展示视频帧组成的 360 转身效果。</p>
  </div>;
}

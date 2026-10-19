'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCw } from 'lucide-react';
import styles from './workbench.module.css';

export function RotationViewer({frames, name}: {frames: string[]; name: string}) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{x: number; frame: number; width: number} | null>(null);
  const count = frames.length;
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
  function show(index: number) {if (count) setFrame(((index % count) + count) % count); setFailed(false);}
  if (!count) return <p className={styles.error}>这条转身记录还没有可显示的帧图片。</p>;
  return <div className={styles.rotationViewer}>
    <div className={styles.rotationStage} aria-label={`${name}转身画面`} onPointerDown={event => {
      if (event.button !== 0) return;
      setPlaying(false); drag.current = {x: event.clientX, frame, width: Math.max(event.currentTarget.getBoundingClientRect().width, 1)};
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }} onPointerMove={event => {if (drag.current) show(drag.current.frame + Math.round((event.clientX - drag.current.x) / drag.current.width * count));}} onPointerUp={() => {drag.current = null;}} onPointerCancel={() => {drag.current = null;}} onLostPointerCapture={() => {drag.current = null;}}>
      <img src={frames[Math.min(frame, count - 1)]} alt={`${name} · 第 ${frame + 1} 帧`} draggable={false} onError={() => {setPlaying(false); setFailed(true);}}/>
    </div>
    <div className={styles.rotationControls}><button type="button" className={styles.secondary} aria-label="上一帧" onClick={() => {setPlaying(false); show(frame - 1);}}><ChevronLeft size={16}/></button><button type="button" className={styles.secondary} disabled={count < 2 || failed} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={15}/> : <Play size={15}/>} {playing ? '暂停转身' : '自动播放'}</button><button type="button" className={styles.secondary} aria-label="下一帧" onClick={() => {setPlaying(false); show(frame + 1);}}><ChevronRight size={16}/></button><span>{frame + 1} / {count} 帧</span></div>
    <label className={styles.rotationSlider}>拖动查看角度<input type="range" min={0} max={count - 1} value={Math.min(frame, count - 1)} aria-label="转身帧位置" onChange={event => {setPlaying(false); show(Number(event.target.value));}}/></label>
    {failed && <p role="alert" className={styles.error}>当前帧加载失败。请刷新这条任务的状态后重试。</p>}
    <p className={styles.small}><RotateCw size={13}/> 左右拖动画面，或使用滑条和方向按钮。这里展示视频帧组成的 360 转身效果。</p>
  </div>;
}

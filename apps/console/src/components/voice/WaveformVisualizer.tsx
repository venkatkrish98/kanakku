'use client';

import React, { useEffect, useRef } from 'react';
import type { VoiceState } from '@/hooks/usePushToTalk';

export interface WaveformVisualizerProps {
  analyserNode: AnalyserNode | null;
  state: VoiceState;
  height?: number;
  width?: number;
}

export function WaveformVisualizer({
  analyserNode,
  state,
  height = 64,
  width = 320,
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase = 0;
    const barCount = 32;
    const dataArray = new Uint8Array(barCount);

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Gradient color palette for sleek Indian financial UI
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      if (state === 'listening') {
        gradient.addColorStop(0, '#f59e0b'); // Warm Amber
        gradient.addColorStop(0.5, '#10b981'); // Emerald Green
        gradient.addColorStop(1, '#06b6d4'); // Cyan Glow
      } else if (state === 'speaking') {
        gradient.addColorStop(0, '#6366f1'); // Indigo
        gradient.addColorStop(0.5, '#8b5cf6'); // Violet
        gradient.addColorStop(1, '#ec4899'); // Pink
      } else if (state === 'processing') {
        gradient.addColorStop(0, '#3b82f6'); // Royal Blue
        gradient.addColorStop(1, '#60a5fa');
      } else {
        gradient.addColorStop(0, '#334155'); // Slate
        gradient.addColorStop(1, '#475569');
      }

      ctx.fillStyle = gradient;

      if (state === 'listening' && analyserNode) {
        // Real microphone data
        const tempArray = new Uint8Array(analyserNode.frequencyBinCount);
        analyserNode.getByteFrequencyData(tempArray);
        const step = Math.floor(tempArray.length / barCount);
        for (let i = 0; i < barCount; i++) {
          dataArray[i] = tempArray[i * step] || 0;
        }
      } else if (state === 'speaking') {
        // Synthesized audio ripple waveform
        phase += 0.08;
        for (let i = 0; i < barCount; i++) {
          const sin = Math.sin(phase + (i * Math.PI) / 8);
          dataArray[i] = Math.max(12, Math.floor(Math.abs(sin) * 180 + 30));
        }
      } else if (state === 'processing') {
        // Subtle rhythmic pulse
        phase += 0.12;
        for (let i = 0; i < barCount; i++) {
          const val = Math.sin(phase + i * 0.4);
          dataArray[i] = Math.max(8, Math.floor(Math.abs(val) * 70 + 20));
        }
      } else {
        // Idle baseline flatline with slight micro-glow
        for (let i = 0; i < barCount; i++) {
          dataArray[i] = 12;
        }
      }

      const barWidth = Math.floor(width / barCount) - 2;
      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i] || 8;
        const barHeight = Math.max(4, (val / 255) * height);
        const x = i * (barWidth + 2);
        const y = (height - barHeight) / 2;

        // Rounded pill bars
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 3);
        ctx.fill();
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [analyserNode, state, height, width]);

  return (
    <div
      className="waveform-container"
      role="region"
      aria-label="Live audio frequency waveform"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0.5rem 1rem',
        background: 'rgba(15, 23, 42, 0.6)',
        backdropFilter: 'blur(8px)',
        borderRadius: '12px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: state === 'listening' ? '0 0 20px rgba(16, 185, 129, 0.2)' : 'none',
        transition: 'box-shadow 0.3s ease',
      }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width: `${width}px`, height: `${height}px` }}
      />
    </div>
  );
}

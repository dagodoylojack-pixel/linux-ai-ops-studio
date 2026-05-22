/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';

// 1. CPU Usage Gauge Graph
export function CPUUsageMeter({ value }: { value: number }) {
  const [history, setHistory] = useState<number[]>([12, 18, 24, 21, 35, 42, value]);

  useEffect(() => {
    setHistory((prev) => {
      const next = [...prev, value];
      if (next.length > 20) {
        next.shift();
      }
      return next;
    });
  }, [value]);

  return (
    <div id="cpu-usage-meter" className="space-y-2">
      <div className="flex justify-between items-center text-xs font-mono">
        <span className="text-zinc-500">REALTIME LOAD WAVE</span>
        <span className="text-emerald-400 font-bold">{value}%</span>
      </div>
      
      {/* Wave Area Bar heights visualization */}
      <div className="h-20 flex items-end gap-1.5 bg-zinc-950/80 rounded-lg p-2 border border-zinc-850">
        {history.map((h, idx) => {
          const barHeight = Math.max(8, Math.round(h));
          const colorClass = h > 85 ? 'bg-red-500' : h > 60 ? 'bg-amber-500' : 'bg-emerald-500';
          return (
            <div
              key={idx}
              style={{ height: `${barHeight}%` }}
              className={`flex-1 rounded-sm ${colorClass} transition-all duration-300 opacity-80 hover:opacity-100`}
              title={`Load: ${h}%`}
            />
          );
        })}
      </div>
    </div>
  );
}

// 2. RAM Memory Gauge
export function RAMUsageMeter({ used, total }: { used: number; total: number }) {
  const percentage = Math.round((used / total) * 100);

  return (
    <div id="ram-usage-meter" className="space-y-2">
      <div className="flex justify-between items-center text-xs font-mono">
        <span className="text-zinc-400">MEMORY ALLOCATION</span>
        <span className="text-amber-400 font-bold">{percentage}% used</span>
      </div>

      <div className="bg-zinc-950/80 p-3 rounded-lg border border-zinc-850 space-y-3">
        {/* Progress Bar */}
        <div className="w-full bg-zinc-900 rounded-full h-2.5 overflow-hidden">
          <div
            style={{ width: `${percentage}%` }}
            className="bg-amber-500 h-2.5 rounded-full transition-all duration-300"
          />
        </div>

        <div className="grid grid-cols-2 gap-2 text-[10px] font-mono leading-tight">
          <div>
            <span className="text-zinc-500 block">COMMIT CHARGE</span>
            <span className="text-zinc-300 font-bold">{used.toFixed(1)} GB</span>
          </div>
          <div className="text-right">
            <span className="text-zinc-500 block">FREE AVAILABLE</span>
            <span className="text-emerald-400 font-bold">{(total - used).toFixed(1)} GB</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface CircularProgressProps {
  value: number;
  strokeColor?: string;
}

// 3. Circular Telemetry Gauge
export function CircularProgress({ value, strokeColor = 'stroke-emerald-400' }: CircularProgressProps) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (Math.min(100, Math.max(0, value)) / 100) * circumference;

  return (
    <div id="circular-progress" className="relative flex items-center justify-center w-12 h-12 flex-shrink-0">
      <svg className="w-12 h-12 transform -rotate-90">
        <circle
          className="stroke-zinc-900"
          strokeWidth="3"
          fill="transparent"
          r={radius}
          cx="24"
          cy="24"
        />
        <circle
          className={`${strokeColor} transition-all duration-500 ease-out`}
          strokeWidth="3.5"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="transparent"
          r={radius}
          cx="24"
          cy="24"
        />
      </svg>
      <span className="absolute text-[9px] font-bold text-zinc-100 font-mono">{value}%</span>
    </div>
  );
}

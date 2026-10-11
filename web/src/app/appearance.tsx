import { useState } from 'react';
export type Appearance = 'system' | 'light' | 'dark';
const key='planner-appearance';
export function readAppearance(): Appearance { try { const value=localStorage.getItem(key);if(value==='light'||value==='dark')return value; } catch { /* Device storage can be unavailable. */ } return 'system'; }
export function applyAppearance(value:Appearance) { document.documentElement.dataset.appearance=value; }
export function AppearancePicker() {
  const [value,setValue]=useState<Appearance>(readAppearance);
  return <label className="appearance-picker">Appearance<select value={value} onChange={event=>{const next=event.target.value as Appearance;setValue(next);applyAppearance(next);try{localStorage.setItem(key,next);}catch{/* Keep working for this session. */}}}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}

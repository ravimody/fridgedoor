import { useRef, useState, type ReactNode } from 'react';
// Horizontal dismissal leaves native vertical scrolling alone. Menus remain available
// to keyboard and assistive-technology users who cannot use the gesture.
export function ReviewItem({title,children,onDismiss,disabled=false,tone='fyi'}:{title:string;children:ReactNode;onDismiss?:(()=>void)|undefined;disabled?:boolean;tone?:'attention'|'fyi'}) {
  const drag=useRef<{x:number;y:number;locked:boolean}|null>(null);const [offset,setOffset]=useState(0);
  function reset(){drag.current=null;setOffset(0);}
  return <article className={`review-swipe ${tone}`} onPointerDown={event=>{if(!onDismiss || disabled || event.button!==0 || (event.target as HTMLElement).closest('a,button,summary,details,input,textarea'))return;drag.current={x:event.clientX,y:event.clientY,locked:false};}} onPointerMove={event=>{const start=drag.current;if(!start)return;const x=event.clientX-start.x,y=event.clientY-start.y;if(!start.locked&&Math.abs(y)>10&&Math.abs(y)>Math.abs(x)){reset();return;}if(!start.locked&&Math.abs(x)>12&&Math.abs(x)>Math.abs(y)*1.5){start.locked=true;event.currentTarget.setPointerCapture(event.pointerId);}if(start.locked)setOffset(Math.min(0,Math.max(-140,x)));}} onPointerUp={()=>{if(drag.current?.locked&&offset<=-90&&!disabled)onDismiss?.();reset();}} onPointerCancel={reset} onLostPointerCapture={reset}>
    {onDismiss && <span className="swipe-label" aria-hidden="true">Dismiss</span>}<div className="review-surface" style={{transform:`translateX(${offset}px)`}}><div className="review-copy">{children}</div>{onDismiss && <details className="review-menu"><summary aria-label={`Options for ${title}`}>···</summary><button disabled={disabled} onClick={onDismiss}>Dismiss</button></details>}</div>
  </article>;
}

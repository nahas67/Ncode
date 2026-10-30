const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./mermaid.core-5y4hT3XP.js","./sandbox-AeI32kY4.js","./web_model_catalog-BZdppIEQ.js","./index-CdqiMk_w.js","./index-D1KN2sgw.css","./ncode_actions-BPP2BI4T.js","./sandbox-Cjnw9yPf.css","./_commonjsHelpers-Cpj98o6Y.js"])))=>i.map(i=>d[i]);
import{L as C,a as A,e as T,n as x,b as k,_ as S}from"./sandbox-AeI32kY4.js";import{d as z}from"./web_model_catalog-BZdppIEQ.js";import{t as l}from"./index-CdqiMk_w.js";async function fe(e){if(!(window.origin==="null")&&navigator.clipboard&&navigator.clipboard.writeText)try{await navigator.clipboard.writeText(e);return}catch(r){console.warn("Clipboard API failed (likely permissions), attempting fallback...",r)}const t=document.createElement("textarea");t.value=e,t.className="clipboard-staging-input",document.body.appendChild(t),t.focus(),t.select();try{if(!document.execCommand("copy"))throw new Error("execCommand returned false")}catch(r){throw new Error("Fallback copy failed: "+r.message)}finally{document.body.removeChild(t)}}const P=new Set([C]),M=new Set(["svg"]),_=new Set(["mermaid","mmd"]),F=new Set(["graphviz","dot"]),R=new Set(["","plaintext","text","txt"]),H=new Set(["applet","base","embed","iframe","link","meta","object","script"]),G=new Set(["srcdoc"]),N=new Set(["action","background","cite","formaction","href","poster","src","xlink:href"]),I=`<script>
(() => {
  const channel = ${JSON.stringify(A)};
  const notify = (event, payload) => {
    try {
      parent.postMessage(payload === undefined ? { channel, event } : { channel, event, payload }, '*');
    } catch {
      // 静默降级:sandbox iframe 中 postMessage 失败时忽略
    }
  };
  const notifyResize = () => {
    try {
      const body = document.body;
      const root = document.documentElement;
      const height = Math.max(
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        root ? root.scrollHeight : 0,
        root ? root.offsetHeight : 0
      );
      parent.postMessage({ channel, event: 'resize', height }, '*');
    } catch {
      // 静默降级:sandbox iframe 中 postMessage 失败或 DOM 不可用时忽略
    }
  };
  let resizeFrame = 0;
  const scheduleResize = () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      notifyResize();
    });
  };
  if (document.readyState === 'complete') {
    Promise.resolve().then(scheduleResize);
  } else {
    window.addEventListener('load', scheduleResize, { once: true });
  }
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleResize);
    if (document.documentElement) observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  if ('MutationObserver' in window) {
    const observer = new MutationObserver(scheduleResize);
    observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
  }
  window.addEventListener('resize', scheduleResize);
  const parseFollowupPayload = (rawPayload) => {
    const trimmedPayload = String(rawPayload || '').trim();
    if (!trimmedPayload) return null;
    try {
      const parsedPayload = JSON.parse(trimmedPayload);
      if (typeof parsedPayload === 'string') {
        const instruction = parsedPayload.trim();
        return instruction ? { instruction } : null;
      }
      return parsedPayload;
    } catch {
      if (/^[{[]/.test(trimmedPayload)) return null;
      return { instruction: trimmedPayload };
    }
  };
  const resolveFollowupScope = (trigger) => {
    const scopeSelector = trigger.getAttribute('data-amc-followup-scope');
    if (scopeSelector && scopeSelector.trim()) {
      try {
        return document.querySelector(scopeSelector) || trigger.closest(scopeSelector) || document;
      } catch {
        return document;
      }
    }
    return trigger.closest('[data-amc-followup-scope]') || document;
  };
  const readStateValue = (element) => {
    if (element instanceof HTMLInputElement) {
      const inputType = element.type.toLowerCase();
      if (inputType === 'checkbox') return element.checked;
      if (inputType === 'radio') return element.checked ? element.value || true : undefined;
      if (inputType === 'number' || inputType === 'range') {
        return element.value === '' || Number.isNaN(element.valueAsNumber) ? element.value : element.valueAsNumber;
      }
      return element.value;
    }
    if (element instanceof HTMLSelectElement) {
      if (element.multiple) return Array.from(element.selectedOptions).map((option) => option.value);
      return element.value;
    }
    if (element instanceof HTMLTextAreaElement) return element.value;
    const stateValue = element.getAttribute('data-amc-state-value');
    if (stateValue !== null) {
      const isToggleLike =
        element.hasAttribute('aria-pressed') ||
        element.hasAttribute('aria-selected') ||
        element.hasAttribute('aria-checked');
      if (!isToggleLike) return stateValue;
      const isActive =
        element.getAttribute('aria-pressed') === 'true' ||
        element.getAttribute('aria-selected') === 'true' ||
        element.getAttribute('aria-checked') === 'true';
      return isActive ? stateValue : undefined;
    }
    const textValue = element.textContent ? element.textContent.trim() : '';
    return textValue || undefined;
  };
  const appendStateValue = (state, key, value) => {
    if (value === undefined) return;
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      state[key] = Array.isArray(state[key]) ? [...state[key], value] : [state[key], value];
      return;
    }
    state[key] = value;
  };
  const collectFollowupState = (trigger) => {
    const scope = resolveFollowupScope(trigger);
    const state = {};
    const stateElements = [];
    if (scope instanceof Element && scope.matches('[data-amc-state-key]')) stateElements.push(scope);
    stateElements.push(...Array.from(scope.querySelectorAll('[data-amc-state-key]')));
    stateElements.forEach((element) => {
      const key = element.getAttribute('data-amc-state-key');
      if (!key || element.disabled) return;
      appendStateValue(state, key, readStateValue(element));
    });
    return state;
  };
  const mergeFollowupState = (payload, collectedState) => {
    if (!collectedState || Object.keys(collectedState).length === 0) return payload;
    const existingState =
      payload && typeof payload.state === 'object' && !Array.isArray(payload.state)
        ? payload.state
        : payload && payload.state !== undefined
          ? { value: payload.state }
          : {};
    return {
      ...payload,
      state: {
        ...existingState,
        ...collectedState,
      },
    };
  };
  const readFollowupPayload = (target) => {
    if (!(target instanceof Element)) return null;
    const trigger = target.closest('[data-amc-followup]');
    if (!trigger) return null;
    const payload = parseFollowupPayload(trigger.getAttribute('data-amc-followup'));
    return payload ? mergeFollowupState(payload, collectFollowupState(trigger)) : null;
  };
  document.addEventListener('click', (event) => {
    const payload = readFollowupPayload(event.target);
    if (!payload) return;
    event.preventDefault();
    notify('followup', payload);
  });
})();
<\/script>`;function $(e){return String(e||"").trim().split(/\s+/)[0].toLowerCase()}function O(e){var n,o;const a=(n=e.dataset)==null?void 0:n.codeLang;if(a)return a;const t=(o=e.querySelector(".code-lang"))==null?void 0:o.textContent;if(t)return t;const r=e.querySelector("pre code"),i=Array.from((r==null?void 0:r.classList)||[]).find(s=>s.startsWith("language-"));return i?i.slice(9):""}function V(e){return/^\s*<svg(?:\s|>)/i.test(e)}function m(e){return/^\s*(?:<!doctype\s+html|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>)|<(?:article|aside|blockquote|button|canvas|caption|details|div|figure|figcaption|footer|form|h[1-6]|header|label|li|main|meter|nav|ol|p|progress|section|select|span|summary|table|tbody|td|tfoot|th|thead|tr|ul|style)(?:\s|>))/i.test(e)}function q(e){return String(e||"").replace(/^(?:\s*%%[^\n]*(?:\n|$))+/,"").trim()}function U(e){return/^(?:c4component|c4container|c4context|classdiagram|erdiagram|flowchart|gantt|gitgraph|graph|journey|mindmap|pie|quadrantchart|requirementdiagram|sequencediagram|statediagram(?:-v2)?|timeline)\b/i.test(q(e))}function B(e){return/^\s*(?:strict\s+)?(?:di)?graph(?:\s+[\w\d_"]+)?\s*\{/i.test(e)}function h(e){const a=String(e||"");return/var\(--amc-live-artifact/i.test(a)||/display\s*:\s*block/i.test(a)&&/width\s*:\s*100%/i.test(a)}function D(e,a=""){const t=$(e),r=String(a||"").trim();if(P.has(t))return m(r)?"html":null;if(M.has(t))return"svg";if(_.has(t))return"mermaid";if(F.has(t))return"graphviz";if(V(r))return"svg";if(R.has(t)){if(m(r)&&h(r))return"html";if(U(r))return"mermaid";if(B(r))return"graphviz"}return(t==="html"||t==="htm"||t==="xml")&&m(r)&&h(r)||(t==="markdown"||t==="md")&&m(r)&&h(r)?"html":null}function E(e){const a=String(e||"").replace(/[\u0000-\u001f]+/g,"").trim();return!a||a.startsWith("#")?!0:/^(https?:|data:image\/(?:gif|jpe?g|png|svg\+xml|webp);base64,|blob:|\/)/i.test(a)}function b(e){return String(e||"").replace(/@import\s+[^;]+;?/gi,"").replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(a,t,r)=>E(r)?a:"").replace(/expression\s*\([^)]*\)/gi,"").replace(/-moz-binding\s*:[^;]+;?/gi,"").replace(/javascript\s*:/gi,"")}function j(e,a){const t=e.tagName.toLowerCase();if(H.has(t)||a==="svg"&&t==="foreignobject"){e.remove();return}Array.from(e.attributes||[]).forEach(r=>{const i=r.name.toLowerCase();if(i.startsWith("on")||G.has(i)){e.removeAttribute(r.name);return}if(N.has(i)&&!E(r.value)){e.removeAttribute(r.name);return}if(i==="style"){const n=b(r.value);n.trim()?e.setAttribute(r.name,n):e.removeAttribute(r.name)}}),t==="style"&&(e.textContent=b(e.textContent||""))}function w(e,a){Array.from(e.querySelectorAll("*")).forEach(t=>j(t,a))}function y(e,a="html"){if(typeof document>"u")return T(e);const t=String(e||"");if(a==="html"){const n=new DOMParser().parseFromString(t,"text/html");return w(n,"html"),`${Array.from(n.head.querySelectorAll("style")).map(s=>s.outerHTML).join("")}${n.body.innerHTML}`.trim()}const r=document.createElement("template");r.innerHTML=t,w(r.content,"svg");const i=r.content.querySelector("svg");return i?i.outerHTML:r.innerHTML.trim()}function W(e,a){const t=y(a,e);return`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: blob:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'unsafe-inline'; connect-src https: data: blob:; media-src https: data: blob:; form-action 'none'; base-uri 'none'">
<style>
html,body{min-height:100%;margin:0;background:transparent;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{box-sizing:border-box;overflow:hidden}
body.artifact-html{padding:0}
body.artifact-svg{display:grid;place-items:center;padding:16px}
*,*::before,*::after{box-sizing:border-box}
img,svg,canvas,video{max-width:100%}
svg{height:auto}
</style>
</head>
<body class="${e==="svg"?"artifact-svg":"artifact-html"}">${t}${e==="html"?I:""}</body>
</html>`}let K=()=>S(()=>import("./mermaid.core-5y4hT3XP.js").then(e=>e.b6),__vite__mapDeps([0,1,2,3,4,5,6,7]),import.meta.url),v=null,J=()=>S(()=>import("./viz-EV0lbze0.js"),[],import.meta.url),f=null;const Z=30,u=new Map;async function X(){return v||(v=K().then(e=>e.default||e)),v}async function Q(){return f||(f=J().then(e=>{var t;const a=e.instance||((t=e.default)==null?void 0:t.instance);if(typeof a!="function")throw new Error(l("liveArtifactPreviewFailed"));return a()}).catch(e=>{throw f=null,e})),f}async function Y(e){const a=await X();if(a.initialize({startOnLoad:!1,securityLevel:"strict",theme:document.documentElement.getAttribute("data-theme")==="dark"?"dark":"default",fontFamily:"inherit",flowchart:{htmlLabels:!1,useMaxWidth:!0}}),typeof a.parse=="function"&&await a.parse(e,{suppressErrors:!1})===!1)throw new Error(l("liveArtifactPreviewFailed"));const t=await a.render(z("mermaid_svg"),e);return(t==null?void 0:t.svg)||""}function ee(e){const a=String(e||"").toLowerCase();return/class=["'][^"']*error-icon/i.test(e)||a.includes("syntax error in text")&&a.includes("mermaid version")}function te(){return document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light"}function re(e){const a=String(e||"").match(/rankdir\s*=\s*(["']?)(LR|TB|RL|BT)\1/i);if(!a)return"LR";const t=a[2].toUpperCase();return t==="TB"||t==="BT"?"TB":"LR"}function ae(e,a=te()){let t=String(e||"");const r=re(t),i=/(rankdir\s*=\s*)(["']?)(LR|TB|RL|BT)\2/gi;if(i.test(t))t=t.replace(i,`$1"${r}"`);else{const c=t.match(/(\s*(?:strict\s+)?(?:di)?graph\s+[\w\d_"]*\s*\{|\s*(?:strict\s+)?(?:di)?graph\s*\{)/i);c&&(t=t.replace(c[0],`${c[0]}
  rankdir="${r}";`))}const n=a==="dark"?"#e4e4e7":"#374151",o=`
        graph [bgcolor="transparent" fontcolor="${n}" margin="0"];
        node [color="${n}" fontcolor="${n}"];
        edge [color="${n}" fontcolor="${n}"];
      `,s=t.indexOf("{");return s!==-1&&(t=t.slice(0,s+1)+o+t.slice(s+1)),{code:t,layout:r,theme:a}}async function ne(e){const a=String(e||"");if(!a.trim())return"";const t=ae(a),r=`${t.theme}::${t.layout}::${a}`;if(u.has(r)){const s=u.get(r);return u.delete(r),u.set(r,s),s}const n=await(await Q()).renderSVGElement(t.code);n.style.maxWidth="100%",n.style.height="auto",n.style.display="block";const o=n.outerHTML;for(u.set(r,o);u.size>Z;)u.delete(u.keys().next().value);return o}function p(e){e.classList.remove("live-artifact-body-error"),e.classList.add("live-artifact-body-loading"),e.setAttribute("aria-busy","true"),e.textContent=l("liveArtifactRendering")}function g(e,a){e.classList.remove("live-artifact-body-loading"),e.classList.add("live-artifact-body-error"),e.removeAttribute("aria-busy"),e.innerHTML="";const t=document.createElement("div");t.className="live-artifact-error",t.textContent=a||l("liveArtifactPreviewFailed"),e.appendChild(t)}function L(e,a){e.classList.remove("live-artifact-body-loading","live-artifact-body-error"),e.removeAttribute("aria-busy"),e.innerHTML=a}function ie(e,a,t=Y,r={}){const i=r.deferErrors===!0;p(e),Promise.resolve(t(a)).then(n=>{if(!e.isConnected)return;if(ee(n))throw new Error(l("liveArtifactPreviewFailed"));const o=y(n,"svg");if(!o){g(e,l("liveArtifactPreviewFailed"));return}L(e,o)}).catch(n=>{if(!e.isConnected)return;if(i){p(e);return}const o=n instanceof Error?n.message:"";g(e,o||l("liveArtifactPreviewFailed"))})}function oe(e){return(e instanceof Error?e.message:"").replace(/.*error:\s*/i,"")||l("liveArtifactPreviewFailed")}function se(e,a,t=ne,r={}){const i=r.deferErrors===!0;p(e),Promise.resolve(t(a)).then(n=>{if(!e.isConnected)return;const o=y(n,"svg");if(!o&&String(a||"").trim()){g(e,l("liveArtifactPreviewFailed"));return}L(e,o)}).catch(n=>{if(e.isConnected){if(i){p(e);return}g(e,oe(n))}})}function ce(e,a,t={}){const r=document.createElement("section");if(r.className="live-artifact-preview",r.dataset.liveArtifactKind=e,e!=="html"){const o=document.createElement("div");o.className="live-artifact-header";const s=document.createElement("span");s.className="live-artifact-title",s.textContent=l("liveArtifactPreview");const c=document.createElement("span");c.className="live-artifact-badge",c.textContent=e.toUpperCase(),o.appendChild(s),o.appendChild(c),r.appendChild(o)}const i=document.createElement("div");if(i.className=`live-artifact-body live-artifact-body-${e}`,r.appendChild(i),e==="mermaid")return ie(i,a,t.renderMermaid,{deferErrors:t.deferMermaidErrors===!0}),r;if(e==="graphviz")return se(i,a,t.renderGraphviz,{deferErrors:t.deferGraphvizErrors===!0}),r;const n=document.createElement("iframe");if(n.className="live-artifact-frame",n.title=`${l("liveArtifactPreviewTitle")} (${e.toUpperCase()})`,n.setAttribute("sandbox",e==="html"?"allow-scripts allow-forms":""),n.referrerPolicy="no-referrer",n.loading="lazy",n.srcdoc=W(e,a),i.appendChild(n),e==="html"){const o=s=>{if(s.source!==n.contentWindow)return;const c=s.data||{};if(c.channel===A){if(c.event==="followup"){const d=x(c.payload);d&&(typeof t.onFollowUp=="function"?t.onFollowUp(d):window.dispatchEvent(new CustomEvent(k,{detail:d})));return}if(c.event==="resize"&&typeof c.height=="number"){const d=Math.max(120,Math.ceil(c.height));n.style.height=`${d}px`}}};window.addEventListener("message",o),r.__liveArtifactCleanup=()=>{window.removeEventListener("message",o)}}return r}function le(e,a){if(a.dataset.liveArtifactEnhanced="true",e.parentNode){e.replaceWith(a);return}e.className="live-artifact-inline-wrapper",e.innerHTML="",e.appendChild(a)}function pe(e){var t;if(!e||typeof document>"u")return;const a=(t=e.querySelectorAll)==null?void 0:t.call(e,'[data-live-artifact-enhanced="true"]');a&&a.forEach(r=>{var n;const i=((n=r.querySelector)==null?void 0:n.call(r,".live-artifact-preview"))||r;typeof i.__liveArtifactCleanup=="function"&&i.__liveArtifactCleanup()})}function ge(e,a={}){var r,i;if(!e||typeof document>"u")return;((r=e.matches)!=null&&r.call(e,".code-block-wrapper")?[e]:Array.from(((i=e.querySelectorAll)==null?void 0:i.call(e,".code-block-wrapper"))||[])).forEach(n=>{if(n.dataset.liveArtifactEnhanced==="true")return;const o=n.querySelector("pre code"),s=(o==null?void 0:o.textContent)||"",c=D(O(n),s);if(!c)return;const d=ce(c,s,a);if(c==="html"){le(n,d);return}n.dataset.liveArtifactEnhanced="true",n.appendChild(d)})}(function(){const e='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';function a(){var r;return((r=globalThis.GeminiToolbarIcons)==null?void 0:r.CHECK)||e}function t(r,i,n=2e3){if(!r)return;const o=r.innerHTML;r.replaceChildren(),r.insertAdjacentHTML("afterbegin",a());const s=document.createElement("span");s.textContent=i,r.appendChild(s),setTimeout(()=>{r.innerHTML=o},n)}globalThis.GeminiCopyFeedback={showCopied:t}})();export{pe as a,fe as c,ge as e};

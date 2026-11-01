/* ATMOS studio. All drawing stays in this browser; no accounts or uploads. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const canvas = $('#weather-canvas');
  const artboard = $('#artboard');
  const cursor = $('#brush-cursor');
  const STORAGE_KEY = 'atmos-weather-studio-v2';
  const palettes = [
    ['#a9e4ff','#77bfe0','#ffec36','#ff5999','#f6f1dc','#30485c'],
    ['#ff864e','#ff5999','#ffdf44','#c65162','#f9d0ba','#4b345f'],
    ['#52a9ad','#b39bdd','#e7ce72','#638da5','#e49aae','#263d52'],
    ['#ca4771','#6c559b','#f3b853','#458f99','#83a767','#232948']
  ];
  const descriptions = {
    cloud: 'Paint molten color. Move slowly and let the clouds unfold.',
    rain: 'Draw liquid rain. Let the streaks fall in any direction.',
    wind: 'Stir the currents. Trace a curve, a spiral, or a quick sweep.',
    sun: 'Bring a soft glow. Click for a halo, drag for a trail of light.',
    erase: 'Lift a little color and give your atmosphere room to breathe.'
  };
  let brush = {tool:'cloud', color:palettes[0][0],size:84,energy:.45,opacity:.65};
  let paletteIndex = 0;
  let background = '#f5f1e7';
  let paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerId = null;
  let toastTimer;
  let saveTimer;
  let pictureURL;
  let study = 1;
  let ready = false;
  let persistenceAvailable = true;
  let engine;

  function notify(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'),3200);
  }

  function save() {
    if (!ready || !persistenceAvailable) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY,JSON.stringify({version:2,scene:engine.getState(),brush,paletteIndex,background,paused,study,title:$('#picture-title').value}));
      } catch (_) {
        persistenceAvailable=false;
        $('.help-note').textContent='Autosave is unavailable in this browser. Use Make picture to export before closing this page.';
        notify('Browser storage is full or unavailable. Use Make picture to save your artwork.');
      }
    },600);
  }

  function updateHistory(info) {
    $('#undo').disabled = !info.canUndo;
    $('#redo').disabled = !info.canRedo;
    $('#stroke-count').textContent = `${info.strokeCount} ${info.strokeCount === 1 ? 'stroke' : 'strokes'}`;
    $('#empty-hint').hidden = info.strokeCount > 0 || Boolean(info.hasAtmosphere);
    if (info.background) { background=info.background; syncBackground(); }
    save();
  }

  engine = new WeatherEngine(canvas,{onChange:updateHistory});

  function updateBrush() {
    engine.setBrush(brush);
    $$('[data-tool]').forEach(button => {
      const active = button.dataset.tool === brush.tool;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    });
    $('#tool-description').textContent=descriptions[brush.tool];
    $('#custom-color').value=brush.color;
    $$('.swatch').forEach(button => {
      const active=button.dataset.color.toLowerCase()===brush.color.toLowerCase();
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    });
    cursor.classList.toggle('erasing',brush.tool==='erase');
    sizeCursor();
    save();
  }

  function renderPalette() {
    $('.palette').replaceChildren();
    palettes[paletteIndex].forEach((color,index) => {
      const button=document.createElement('button');
      button.className='swatch';
      button.style.setProperty('--swatch',color);
      button.dataset.color=color;
      button.title=`Color ${index+1} · ${color}`;
      button.setAttribute('aria-label',`Choose color ${color}`);
      button.addEventListener('click',()=>{brush.color=color;updateBrush();});
      $('.palette').append(button);
    });
    updateBrush();
  }

  function sizeCursor() {
    const px=brush.size*artboard.clientWidth/1440;
    cursor.style.width=`${Math.max(9,px)}px`;
    cursor.style.height=`${Math.max(9,px)}px`;
  }

  function syncBackground() {
    $$('[data-paper]').forEach(button=>{
      const active=button.dataset.paper===background;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    });
  }

  function syncPause() {
    engine.setPaused(paused);
    $('#pause').classList.toggle('paused',paused);
    $('#pause').setAttribute('aria-pressed',String(paused));
    $('#pause-label').textContent=paused?'Paused':'Weather in motion';
    $('#pause-icon use').setAttribute('href',paused?'#i-play':'#i-pause');
    $('#pause').title=paused?'Resume motion · Space':'Pause motion · Space';
    $('#pause').setAttribute('aria-label',paused?'Resume motion':'Pause motion');
    save();
  }

  function syncSliders() {
    const sliders = [{id:'brush-size',value:brush.size,suffix:''},{id:'brush-energy',value:Math.round(brush.energy*100),suffix:'%'},{id:'brush-opacity',value:Math.round(brush.opacity*100),suffix:'%'}];
    sliders.forEach(({id,value,suffix})=>{
      const input=$(`#${id}`);
      input.value=value;
      $(`#${id}-value`).textContent=value+suffix;
      input.style.setProperty('--fill',`${(value-Number(input.min))/(Number(input.max)-Number(input.min))*100}%`);
    });
  }

  function refreshStudy() {$('#study-number').textContent=String(study).padStart(3,'0');}

  function newCanvas() {
    endPointer();
    engine.clear();
    study++;
    refreshStudy();
    $('#picture-title').value='Untitled atmosphere';
    save();
    notify('A fresh canvas. Choose a medium, then hold and drag to draw.');
  }

  function loadDemo(name) {
    endPointer();
    const moods={drift:{palette:0,bg:'#f5f1e7',title:'Daydream'},storm:{palette:1,bg:'#f0d9cc',title:'Solar flare'},nocturne:{palette:2,bg:'#172a39',title:'Night tide'}};
    const mood=moods[name];
    engine.loadDemo(name);
    paletteIndex=mood.palette;
    background=mood.bg;
    brush.color=palettes[paletteIndex][0];
    brush.tool='cloud';
    renderPalette();
    syncBackground();
    $('#picture-title').value=mood.title;
    save();
  }

  function coordinates(event) {
    const r=canvas.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))};
  }

  function moveCursor(event) {
    const r=artboard.getBoundingClientRect();
    cursor.style.left=`${event.clientX-r.left}px`;
    cursor.style.top=`${event.clientY-r.top}px`;
    cursor.hidden=event.pointerType==='touch';
  }

  function endPointer() {
    if(pointerId===null) return;
    engine.endStroke();
    if(canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    pointerId=null;
    save();
  }

  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0 || pointerId!==null) return;
    event.preventDefault();
    canvas.focus({preventScroll:true});
    pointerId=event.pointerId;
    canvas.setPointerCapture(pointerId);
    moveCursor(event);
    const p=coordinates(event);
    engine.beginStroke(p.x,p.y);
    $('#empty-hint').hidden=true;
  });
  canvas.addEventListener('pointermove',event=>{
    moveCursor(event);
    if(event.pointerId!==pointerId) return;
    const events=event.getCoalescedEvents?.() || [event];
    (events.length?events:[event]).forEach(item=>{
      const p=coordinates(item);
      engine.continueStroke(p.x,p.y);
    });
  });
  canvas.addEventListener('pointerup',event=>{if(event.pointerId===pointerId)endPointer();});
  canvas.addEventListener('pointercancel',event=>{if(event.pointerId===pointerId)endPointer();});
  canvas.addEventListener('lostpointercapture',endPointer);
  canvas.addEventListener('pointerleave',()=>{cursor.hidden=true;});
  window.addEventListener('blur',endPointer);
  window.addEventListener('resize',sizeCursor);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)endPointer();});

  $$('[data-tool]').forEach(button=>button.addEventListener('click',()=>{brush.tool=button.dataset.tool;updateBrush();}));
  $('#shuffle-palette').addEventListener('click',()=>{paletteIndex=(paletteIndex+1)%palettes.length;brush.color=palettes[paletteIndex][0];renderPalette();notify(['Daydream · Blue, pink, and sunshine','Solar flare · Warm color in motion','Night tide · Teal, lilac, and gold','Electric · A little more daring'][paletteIndex]);});
  $('#custom-color').addEventListener('input',event=>{brush.color=event.target.value;updateBrush();});
  ['brush-size','brush-energy','brush-opacity'].forEach(id=>{
    $(`#${id}`).addEventListener('input',event=>{
      const value=Number(event.target.value);
      if(id==='brush-size')brush.size=value;
      if(id==='brush-energy')brush.energy=value/100;
      if(id==='brush-opacity')brush.opacity=value/100;
      syncSliders();updateBrush();
    });
  });
  $$('[data-paper]').forEach(button=>button.addEventListener('click',()=>{background=button.dataset.paper;engine.setBackground(background);syncBackground();save();}));
  $('#pause').addEventListener('click',()=>{paused=!paused;syncPause();});
  $('#undo').addEventListener('click',()=>{endPointer();engine.undo();syncRestoredPaper();});
  $('#redo').addEventListener('click',()=>{endPointer();engine.redo();syncRestoredPaper();});
  function syncRestoredPaper(){const state=engine.getState();if(state.background){background=state.background;syncBackground();}save();}
  $('#new-canvas').addEventListener('click',newCanvas);
  $('#start-blank').addEventListener('click',newCanvas);
  $$('[data-demo]').forEach(button=>button.addEventListener('click',()=>{loadDemo(button.dataset.demo);notify('A new atmosphere to draw into. Undo takes you back to your last artwork.');}));
  $('#picture-title').addEventListener('input',save);
  $('#help').addEventListener('click',()=>$('#help-dialog').showModal());

  $('#make-picture').addEventListener('click',async()=>{
    endPointer();
    const button=$('#make-picture');
    button.disabled=true;
    try {
      const blob=await engine.exportPNG();
      if(!blob)throw new Error('No image');
      if(pictureURL)URL.revokeObjectURL(pictureURL);
      pictureURL=URL.createObjectURL(blob);
      const title=$('#picture-title').value.trim()||'Untitled atmosphere';
      $('#picture-preview').src=pictureURL;
      $('#picture-preview').onload=()=>{$('#export-resolution').textContent=`${$('#picture-preview').naturalWidth} × ${$('#picture-preview').naturalHeight}`;};
      $('#export-title').textContent=title;
      $('#download-picture').href=pictureURL;
      $('#download-picture').download=`atmos-${title.replace(/[<>:"/\\|?*\x00-\x1F]/g,'-')}.png`;
      $('#picture-dialog').showModal();
    } catch(error){console.error(error);notify('Your picture could not be created. Please try again.');}
    finally{button.disabled=false;}
  });

  $$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));

  document.addEventListener('keydown',event=>{
    if(event.target.matches('input,textarea,select') || document.querySelector('dialog[open]'))return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){
      event.preventDefault();endPointer();event.shiftKey?engine.redo():engine.undo();syncRestoredPaper();return;
    }
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){
      event.preventDefault();endPointer();engine.redo();syncRestoredPaper();return;
    }
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    const tool={'1':'cloud','2':'rain','3':'wind','4':'sun','e':'erase'}[event.key.toLowerCase()];
    if(tool){brush.tool=tool;updateBrush();}
    if(event.code==='Space'){event.preventDefault();paused=!paused;syncPause();}
    if(event.key==='['||event.key===']'){brush.size=Math.max(20,Math.min(180,brush.size+(event.key==='['?-10:10)));syncSliders();updateBrush();}
  });

  let restored=false;
  try {
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
    if(saved?.version===2&&saved.scene){
      engine.restoreState(saved.scene);
      brush={...brush,...saved.brush};
      paletteIndex=Math.max(0,Math.min(palettes.length-1,saved.paletteIndex||0));
      background=saved.background||background;
      paused=Boolean(saved.paused);
      study=saved.study||1;
      $('#picture-title').value=typeof saved.title === 'string' && !/\p{Script=Han}/u.test(saved.title) ? saved.title : 'Untitled atmosphere';
      restored=true;
    }
  }catch(_){ /* Private browsing or an older draft: start with a fresh study. */ }
  if(!restored)loadDemo('drift');
  renderPalette();
  syncSliders();syncBackground();syncPause();refreshStudy();
  ready=true;
  save();
  if(restored)notify('Your atmosphere is still here. Pick up where you left off.');
})();

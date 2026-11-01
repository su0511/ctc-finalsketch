/* ATMOS: a mouse-painted atmosphere.
 * The nested, domain-warped fBM and three-color interpolation are adapted from
 * the supplied Warp fBM Shader. Persistent, seeded strokes add pigment and
 * directional flow to that field. Canvas state is independent of frame rate.
 */
(() => {
  'use strict';
  const W = 1440, H = 1000, TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const copy = value => JSON.parse(JSON.stringify(value));
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const rgb = color => [1,3,5].map(i => parseInt(color.slice(i,i+2),16));
  const rgba = (color, a) => `rgba(${rgb(color).join(',')},${a})`;
  const makeCanvas = (w=W,h=H) => Object.assign(document.createElement('canvas'),{width:w,height:h});
  function seed() { const data=new Uint32Array(1); crypto.getRandomValues(data); return data[0] || 1; }
  function random(value) { let a=value>>>0; return ()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;}; }

  const vertex = `attribute vec2 a_position;
    void main(){gl_Position=vec4(a_position,0.0,1.0);}`;
  const fragment = `
    precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_seed;
    uniform float u_atmosphere;
    uniform sampler2D u_ink;
    uniform sampler2D u_flow;
    uniform sampler2D u_erased;
    uniform vec3 u_background;
    uniform vec3 u_colorA;
    uniform vec3 u_colorB;
    uniform vec3 u_colorC;
    const mat2 mtx=mat2(0.80,0.60,-0.60,0.80);
    float rand(vec2 n){return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453);}
    float noise(vec2 p){
      vec2 ip=floor(p),u=fract(p);u=u*u*(3.0-2.0*u);
      float res=mix(mix(rand(ip),rand(ip+vec2(1.0,0.0)),u.x),
        mix(rand(ip+vec2(0.0,1.0)),rand(ip+vec2(1.0,1.0)),u.x),u.y);
      return res*res;
    }
    float fbm(vec2 p){
      float f=0.5*noise(p+u_time*0.045);p=mtx*p*2.02;
      f+=0.03125*noise(p);p=mtx*p*2.01;
      f+=0.25*noise(p);p=mtx*p*2.03;
      f+=0.125*noise(p);p=mtx*p*2.01;
      f+=0.0625*noise(p);p=mtx*p*2.04;
      f+=0.015625*noise(p+sin(u_time*0.07));
      return f/0.96875;
    }
    float pattern(vec2 p){return fbm(p+fbm(p+fbm(p)));}
    vec3 palette(float f){
      return f<0.5 ? mix(u_colorA,u_colorB,f*2.0)
                   : mix(u_colorB,u_colorC,(f-0.5)*2.0);
    }
    void main(){
      vec2 uv=gl_FragCoord.xy/u_resolution;
      vec4 flow=texture2D(u_flow,uv);
      vec2 direction=(flow.rg*2.0-1.0)*flow.a;
      vec2 p=uv*vec2(1.44,1.0)*2.15+u_seed;
      p+=direction*0.72;
      float field=pattern(p);
      float shade=clamp((field-0.065)*1.49,0.0,1.0);
      vec3 atmosphere=palette(shade);
      vec3 color=mix(u_background,atmosphere,u_atmosphere);
      float curl=fbm(p+vec2(13.4,5.2));
      vec2 displacement=vec2(field-0.37,curl-0.37)*(0.07+flow.a*0.045);
      // Warping the pigment lookup makes hand-drawn edges follow the same
      // liquid field as the ambient color, instead of sitting on top of it.
      vec2 inkUV=clamp(uv+displacement,vec2(0.001),vec2(0.999));
      vec4 ink=texture2D(u_ink,inkUV);
      float density=1.0-pow(1.0-ink.a,1.5);
      density*=0.83+field*0.26;
      vec3 pigment=mix(ink.rgb*0.86,mix(ink.rgb,vec3(1.0),0.24),smoothstep(0.12,0.72,field));
      // The upper end of the field opens a pale, luminous edge in the paint.
      pigment=mix(pigment,mix(ink.rgb,u_colorB,0.18),smoothstep(0.35,0.68,curl)*0.15);
      color=mix(color,pigment,clamp(density,0.0,1.0));
      float erased=texture2D(u_erased,uv).a;
      color=mix(color,u_background,erased);
      gl_FragColor=vec4(clamp(color,0.0,1.0),1.0);
    }
  `;

  class WeatherEngine {
    constructor(target,options={}) {
      this.canvas=target;target.width=W;target.height=H;this.ctx=target.getContext('2d');
      this.onChange=typeof options==='function'?options:options.onChange||(()=>{});
      this.brush={tool:'cloud',color:'#a9e4ff',size:84,energy:.45,opacity:.65};
      this.background='#f5f1e7';this.atmosphere=null;this.strokes=[];
      this.history=[];this.future=[];this.active=null;this.paused=false;
      this.time=0;this.sceneSeed=seed();this.dirty=true;this.texturesDirty=true;
      this.ink=makeCanvas();this.flow=makeCanvas();this.erased=makeCanvas();
      this.inkCtx=this.ink.getContext('2d');this.flowCtx=this.flow.getContext('2d');this.eraseCtx=this.erased.getContext('2d');
      this.gpuCanvas=makeCanvas(960,Math.round(960/1.44));this.gl=null;this.destroyed=false;
      this._initGL();this.lastFrame=0;this.fallbackTime=-1;this._frame=this._frame.bind(this);
      this._resize=()=>{this.dirty=true;};window.addEventListener('resize',this._resize);
      this._raf=requestAnimationFrame(this._frame);this._notify();
    }
    _initGL() {
      const gl=this.gpuCanvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
      if(!gl)return;
      const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw Error(message);}return shader;};
      try {
        this.program=gl.createProgram();const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
        gl.attachShader(this.program,vs);gl.attachShader(this.program,fs);gl.linkProgram(this.program);
        if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(this.program));
        gl.deleteShader(vs);gl.deleteShader(fs);gl.useProgram(this.program);
        this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
        const position=gl.getAttribLocation(this.program,'a_position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        this.uniforms={};['resolution','time','seed','atmosphere','background','colorA','colorB','colorC','ink','flow','erased'].forEach(name=>{this.uniforms[name]=gl.getUniformLocation(this.program,`u_${name}`);});
        this.textures=['ink','flow','erased'].map((name,i)=>{
          const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,texture);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
          gl.uniform1i(this.uniforms[name],i);return texture;
        });
        this.gl=gl;
        this.gpuCanvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.gl=null;this.dirty=true;this._notify();});
        this.gpuCanvas.addEventListener('webglcontextrestored',()=>{this._initGL();this.texturesDirty=true;this.dirty=true;});
      }catch(error){console.warn('Using the simplified fluid preview.',error.message);this.gl=null;}
    }
    setBrush(settings={}) {
      if(['cloud','rain','wind','sun','erase'].includes(settings.tool))this.brush.tool=settings.tool;
      if(validColor(settings.color))this.brush.color=settings.color;
      if(Number.isFinite(+settings.size))this.brush.size=clamp(+settings.size,12,240);
      if(Number.isFinite(+settings.energy))this.brush.energy=clamp(+settings.energy,0,1);
      if(Number.isFinite(+settings.opacity))this.brush.opacity=clamp(+settings.opacity,.04,1);
    }
    setBackground(color){if(!validColor(color)||color===this.background)return;this._checkpoint();this.background=color;this.dirty=true;this._notify();}
    setPaused(value){this.paused=Boolean(value);this.dirty=true;}
    _notify(){this.onChange({canUndo:!!this.history.length,canRedo:!!this.future.length,strokeCount:this.strokes.length,background:this.background,paused:this.paused,hasAtmosphere:!!this.atmosphere,renderer:this.gl?'webgl':'canvas'});}
    _checkpoint(){this.history.push(this.getState());if(this.history.length>40)this.history.shift();this.future=[];}
    _point(x,y){return{x:clamp(Number(x)||0,0,1)*W,y:clamp(Number(y)||0,0,1)*H,t:performance.now()};}
    beginStroke(x,y){
      if(this.active)this.endStroke();this._checkpoint();
      const s={id:`stroke-${seed()}`,seed:seed(),...this.brush,points:[this._point(x,y)]};
      this.active=s;this.strokes.push(s);this.strokeDistance=0;this.dotIndex=0;
      this._dot(s,s.points[0],{dx:0,dy:1,speed:.2},0);this._notify();
    }
    continueStroke(x,y){
      if(!this.active)return;const p=this._point(x,y),s=this.active,last=s.points.at(-1);
      if(Math.hypot(p.x-last.x,p.y-last.y)<2)return;
      s.points.push(p);this._segment(s,last,p,s.points.length-1);
    }
    endStroke(){if(!this.active)return;this.active=null;this.dirty=true;this._notify();}
    _segment(s,a,b,segmentIndex){
      const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);if(length<.01)return;
      const gap=Math.max(4,s.size*(s.tool==='rain'?.21:.18));
      const tangent={dx:dx/length,dy:dy/length,speed:clamp(length/Math.max(8,b.t-a.t)/2,.03,1)};
      let distance=gap-this.strokeDistance;
      for(;distance<=length;distance+=gap){this._dot(s,{x:a.x+dx*distance/length,y:a.y+dy*distance/length},tangent,++this.dotIndex);}
      this.strokeDistance=(this.strokeDistance+length)%gap;
      // One short drag still paints even when it does not reach the stamp gap.
      if(segmentIndex===1&&length<gap)this._dot(s,b,tangent,++this.dotIndex);
    }
    _soft(ctx,x,y,radius,color,alpha,stretch=1,angle=0){
      ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.scale(stretch,1);
      const g=ctx.createRadialGradient(0,0,0,0,0,radius);
      g.addColorStop(0,rgba(color,alpha));g.addColorStop(.4,rgba(color,alpha*.8));g.addColorStop(.76,rgba(color,alpha*.28));g.addColorStop(1,rgba(color,0));
      ctx.fillStyle=g;ctx.fillRect(-radius,-radius,radius*2,radius*2);ctx.restore();
    }
    _dot(s,p,tangent,index){
      const rng=random(s.seed+index*173),jitter=s.size*s.energy*.18;
      const x=p.x+(rng()-.5)*jitter,y=p.y+(rng()-.5)*jitter;
      const radius=s.size*(.9+rng()*.35)*(1-tangent.speed*s.energy*.2);
      const alpha=s.opacity*(.16+rng()*.085);
      const angle=Math.atan2(tangent.dy,tangent.dx);
      if(s.tool==='erase'){
        this.inkCtx.globalCompositeOperation='destination-out';this.flowCtx.globalCompositeOperation='destination-out';
        this._soft(this.inkCtx,x,y,radius,'#ffffff',.65);this._soft(this.flowCtx,x,y,radius,'#ffffff',.65);
        this.inkCtx.globalCompositeOperation='source-over';this.flowCtx.globalCompositeOperation='source-over';
        this._soft(this.eraseCtx,x,y,radius,'#ffffff',.65);
      }else{
        this.eraseCtx.globalCompositeOperation='destination-out';this._soft(this.eraseCtx,x,y,radius*1.25,'#ffffff',.6);this.eraseCtx.globalCompositeOperation='source-over';
        if(s.tool==='cloud')this._soft(this.inkCtx,x,y,radius*1.2,s.color,alpha,1.1,angle);
        if(s.tool==='rain'){
          for(let k=0;k<3;k++){
            const spread=(k-1)*s.size*.44+(rng()-.5)*s.size*.15;
            this._soft(this.inkCtx,x-tangent.dy*spread,y+tangent.dx*spread,radius*.2,s.color,alpha*1.7,3.8+s.energy*3,angle);
          }
        }
        if(s.tool==='wind'){
          for(let k=0;k<3;k++){
            const offset=(k-1)*s.size*.32;
            this._soft(this.inkCtx,x-tangent.dy*offset,y+tangent.dx*offset,radius*.19,s.color,alpha*.72,2.7,angle);
          }
        }
        if(s.tool==='sun')this._soft(this.inkCtx,x,y,radius*1.65,s.color,alpha*.75,1,angle);
        const dx=tangent.dx*(.45+s.energy*.5),dy=-tangent.dy*(.45+s.energy*.5);
        const channel=v=>Math.round(clamp(v,0,255)).toString(16).padStart(2,'0');
        const flowColor=`#${channel((dx*.5+.5)*255)}${channel((dy*.5+.5)*255)}${channel(s.energy*255)}`;
        this._soft(this.flowCtx,x,y,radius*(s.tool==='wind'?2:1.4),flowColor,(s.tool==='wind'?.4:.16)*(.2+s.energy));
      }
      this.texturesDirty=true;this.dirty=true;
    }
    _rebuild(){
      [this.inkCtx,this.flowCtx,this.eraseCtx].forEach(ctx=>ctx.clearRect(0,0,W,H));
      for(const s of this.strokes){this.strokeDistance=0;this.dotIndex=0;this._dot(s,s.points[0],{dx:0,dy:1,speed:.2},0);for(let i=1;i<s.points.length;i++)this._segment(s,s.points[i-1],s.points[i],i);}
      this.texturesDirty=true;this.dirty=true;
    }
    clear(){if(!this.strokes.length&&!this.atmosphere)return;this.endStroke();this._checkpoint();this.strokes=[];this.atmosphere=null;this.sceneSeed=seed();this._rebuild();this._notify();}
    undo(){this.endStroke();if(!this.history.length)return;this.future.push(this.getState());this._restore(this.history.pop());this._notify();}
    redo(){this.endStroke();if(!this.future.length)return;this.history.push(this.getState());this._restore(this.future.pop());this._notify();}
    getState(){return copy({version:2,width:W,height:H,background:this.background,atmosphere:this.atmosphere,sceneSeed:this.sceneSeed,time:this.time,strokes:this.strokes});}
    _restore(state){this.background=state.background;this.atmosphere=state.atmosphere||null;this.sceneSeed=state.sceneSeed||seed();this.time=state.time||0;this.strokes=copy(state.strokes);this.active=null;this.fallbackTime=-1;this._rebuild();}
    restoreState(state){
      if(!state||![1,2].includes(state.version)||!validColor(state.background)||!Array.isArray(state.strokes)||state.strokes.length>2000)throw Error('Invalid Atmos picture.');
      if(state.atmosphere&&(!Array.isArray(state.atmosphere.colors)||state.atmosphere.colors.length!==3||!state.atmosphere.colors.every(validColor)))throw Error('Invalid atmosphere colors.');
      for(const s of state.strokes){
        if(!['cloud','rain','wind','sun','erase'].includes(s.tool)||!validColor(s.color)||!Number.isFinite(s.seed)||!Number.isFinite(s.size)||s.size<1||s.size>500||!Number.isFinite(s.opacity)||s.opacity<0||s.opacity>1||!Number.isFinite(s.energy)||s.energy<0||s.energy>1||!Array.isArray(s.points)||!s.points.length||s.points.length>100000||!s.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.t)&&p.x>=-500&&p.x<=W+500&&p.y>=-500&&p.y<=H+500))throw Error('Invalid picture stroke.');
      }
      this.endStroke();this._checkpoint();this._restore(state);this._notify();
    }
    loadDemo(name='drift'){
      this.endStroke();this._checkpoint();this.strokes=[];this.sceneSeed=seed();this.time=0;this.fallbackTime=-1;
      const scenes={
        drift:{colors:['#a9e4ff','#ffec36','#ff5999'],background:'#f5f1e7'},
        storm:{colors:['#f7adc5','#ffd354','#ed6c3b'],background:'#f0d9cc'},
        nocturne:{colors:['#143e65','#598c9f','#d9a9ee'],background:'#172a39'}
      };
      const scene=scenes[name]||scenes.drift;this.atmosphere={colors:scene.colors};this.background=scene.background;this._rebuild();this._notify();
    }
    _frame(now){
      if(this.destroyed)return;this._raf=requestAnimationFrame(this._frame);
      if(document.hidden){this.lastFrame=now;return;}
      if(now-this.lastFrame<40)return;
      const dt=Math.min(100,now-this.lastFrame)/1000;this.lastFrame=now;
      if(!this.paused)this.time+=dt;
      if(this.dirty||(!this.paused&&(this.strokes.length||this.atmosphere))){this._render(this.ctx,W,H);this.dirty=false;}
    }
    _upload(){
      const gl=this.gl;gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      [this.ink,this.flow,this.erased].forEach((source,i)=>{gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.textures[i]);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);});this.texturesDirty=false;
    }
    _render(ctx,w,h,exporting=false){
      if(!this.gl){this._renderFallback(ctx,w,h);return;}
      const gl=this.gl;
      const visibleWidth=this.canvas.getBoundingClientRect().width||900;
      const previewWidth=Math.max(540,Math.min(1100,Math.round(visibleWidth*Math.min(devicePixelRatio||1,1.4))));
      const rw=exporting?w:previewWidth,rh=exporting?h:Math.round(previewWidth/1.44);
      if(this.gpuCanvas.width!==rw||this.gpuCanvas.height!==rh){this.gpuCanvas.width=rw;this.gpuCanvas.height=rh;}
      gl.viewport(0,0,rw,rh);gl.useProgram(this.program);if(this.texturesDirty)this._upload();
      const u=this.uniforms;gl.uniform2f(u.resolution,rw,rh);gl.uniform1f(u.time,this.time);
      gl.uniform2f(u.seed,(this.sceneSeed%131)*.113,(Math.floor(this.sceneSeed/131)%127)*.127);
      gl.uniform1f(u.atmosphere,this.atmosphere?1:0);gl.uniform3fv(u.background,rgb(this.background).map(x=>x/255));
      const colors=this.atmosphere?.colors||['#a9e4ff','#ffec36','#ff5999'];
      ['colorA','colorB','colorC'].forEach((name,i)=>gl.uniform3fv(u[name],rgb(colors[i]).map(x=>x/255)));
      gl.drawArrays(gl.TRIANGLES,0,6);ctx.clearRect(0,0,w,h);ctx.drawImage(this.gpuCanvas,0,0,w,h);
    }
    _renderFallback(ctx,w,h){
      // Keep drawing/export available if WebGL is disabled. This lightweight
      // preview uses smooth color veils; the full fBM renderer runs with WebGL.
      ctx.save();ctx.scale(w/W,h/H);ctx.fillStyle=this.background;ctx.fillRect(0,0,W,H);
      if(this.atmosphere){
        ctx.fillStyle=this.atmosphere.colors[0];ctx.fillRect(0,0,W,H);
        const rng=random(this.sceneSeed);
        for(let i=0;i<16;i++){const x=rng()*W+Math.sin(this.time*.08+i)*60,y=rng()*H+Math.cos(this.time*.07+i)*60;this._soft(ctx,x,y,250+rng()*330,this.atmosphere.colors[1+i%2],.65,1.25,i);}
      }
      ctx.drawImage(this.ink,0,0);
      const mask=makeCanvas(),mc=mask.getContext('2d');mc.fillStyle=this.background;mc.fillRect(0,0,W,H);mc.globalCompositeOperation='destination-in';mc.drawImage(this.erased,0,0);ctx.drawImage(mask,0,0);ctx.restore();
    }
    exportPNG(){
      this.endStroke();const out=makeCanvas(W*2,H*2);this._render(out.getContext('2d'),W*2,H*2,true);this.dirty=true;
      return new Promise((resolve,reject)=>out.toBlob(blob=>blob?resolve(blob):reject(Error('Could not export this picture.')),'image/png'));
    }
    destroy(){this.destroyed=true;cancelAnimationFrame(this._raf);window.removeEventListener('resize',this._resize);if(this.gl){this.textures.forEach(t=>this.gl.deleteTexture(t));this.gl.deleteProgram(this.program);this.gl.deleteBuffer(this.buffer);}}
  }
  window.WeatherEngine=WeatherEngine;
})();

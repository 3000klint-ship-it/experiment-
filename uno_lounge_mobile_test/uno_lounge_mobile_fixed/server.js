
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map();

const COLORS = ["red","yellow","green","blue"];
const TYPES = ["number","skip","reverse","draw2","wild","wild4"];

function id(){ return crypto.randomBytes(8).toString("hex"); }
function code(){ let s; do { s = crypto.randomBytes(3).toString("hex").toUpperCase(); } while(rooms.has(s)); return s; }

function makeDeck(){
  const d=[]; let n=0;
  for(const color of COLORS){
    d.push({id:"c"+(++n),color,type:"number",value:0});
    for(let v=1;v<=9;v++) for(let k=0;k<2;k++) d.push({id:"c"+(++n),color,type:"number",value:v});
    for(const type of ["skip","reverse","draw2"]) for(let k=0;k<2;k++) d.push({id:"c"+(++n),color,type});
  }
  for(let k=0;k<4;k++) d.push({id:"c"+(++n),color:"wild",type:"wild"});
  for(let k=0;k<4;k++) d.push({id:"c"+(++n),color:"wild",type:"wild4"});
  return d;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function safeRoom(r){
  return {
    code:r.code, hostId:r.hostId, maxPlayers:r.maxPlayers,
    minCards:r.minCards, maxCards:r.maxCards,
    players:r.players.map(p=>({id:p.id,username:p.username,avatar:p.avatar,host:p.id===r.hostId,connected:!!p.ws}))
  };
}
function broadcast(r,msg){
  const s=JSON.stringify(msg);
  for(const p of r.players) if(p.ws && p.ws.readyState===WebSocket.OPEN) p.ws.send(s);
}
function broadcastState(r){
  const base=safeRoom(r);
  for(const p of r.players){
    if(!p.ws || p.ws.readyState!==WebSocket.OPEN) continue;
    const game=r.game ? {
      players:r.game.players.map(x=>({
        id:x.id,username:x.username,avatar:x.avatar,seat:x.seat,handCount:x.hand.length,
        calledUno:x.calledUno,connected:!!r.players.find(q=>q.id===x.id)?.ws
      })),
      turn:r.game.turn,discard:r.game.discard,currentColor:r.game.currentColor,
      drawStack:r.game.drawStack,winner:r.game.winner||null,
      hand:(r.game.players.find(x=>x.id===p.id)||{hand:[]}).hand
    } : null;
    p.ws.send(JSON.stringify({type:"state",room:base,game}));
  }
}
function playerOf(r,id){ return r.players.find(p=>p.id===id); }
function gamePlayer(r,id){ return r.game?.players.find(p=>p.id===id); }

function drawCards(r,g, gp, count){
  let drawn=0;
  while(drawn<count && gp.hand.length<r.maxCards){
    if(!g.deck.length){
      const keep=g.discard;
      const refill=g.discardPile || [];
      g.deck=shuffle(refill.splice(0));
      if(keep) g.discardPile=[];
    }
    if(!g.deck.length) break;
    gp.hand.push(g.deck.pop()); drawn++;
  }
  return drawn;
}
function canPlay(g,c){
  const top=g.discard;
  if(g.drawStack>0) return c.type==="draw2" || c.type==="wild4";
  if(c.type==="wild" || c.type==="wild4") return true;
  return c.color===g.currentColor ||
    (c.type==="number" && top.type==="number" && c.value===top.value) ||
    (c.type!=="number" && c.type===top.type);
}
function nextSeat(g,steps=1){
  let s=g.turn;
  for(let i=0;i<steps;i++) s=(s+1)%g.players.length;
  return s;
}
function advance(g,steps=1){ g.turn=nextSeat(g,steps); }

function startGame(r){
  if(r.players.length<2) throw Error("Need at least 2 players.");
  const deck=shuffle(makeDeck());
  const gps=r.players.map((p,i)=>({id:p.id,username:p.username,avatar:p.avatar,seat:i,hand:[],calledUno:false}));
  const g={players:gps,deck,discardPile:[],discard:null,currentColor:null,turn:0,drawStack:0,winner:null};
  for(const gp of gps) drawCards(r,g,gp,r.minCards);

  // Start with a non-wild card so the first color is clear.
  while(true){
    const c=g.deck.pop();
    if(c && c.color!=="wild"){ g.discard=c; g.currentColor=c.color; break; }
    if(c) g.discardPile.push(c);
  }
  r.game=g;
  broadcast(r,{type:"started"});
  broadcastState(r);
}
function finishGame(r,winnerId){
  if(!r.game) return;
  r.game.winner=winnerId;
  broadcast(r,{type:"winner",username:gamePlayer(r,winnerId)?.username||"Player"});
  broadcastState(r);
}
function handlePlay(r,p,msg){
  const g=r.game, gp=gamePlayer(r,p.id);
  if(!g||g.winner) return;
  if(g.players[g.turn]?.id!==p.id) return;
  const idx=gp.hand.findIndex(c=>c.id===msg.cardId);
  if(idx<0) return;
  const c=gp.hand[idx];
  if(!canPlay(g,c)) return;
  if((c.type==="wild"||c.type==="wild4") && !COLORS.includes(msg.color)) return;

  gp.hand.splice(idx,1);
  g.discardPile.push(g.discard);
  g.discard=c;
  g.currentColor=(c.color==="wild")?msg.color:c.color;
  if(c.type==="draw2") g.drawStack+=2;
  else if(c.type==="wild4") g.drawStack+=4;

  if(gp.hand.length===0){ finishGame(r,gp.id); return; }

  if(gp.hand.length===1) gp.calledUno=false;
  if(gp.hand.length>1) gp.calledUno=false;

  let steps=1;
  if(c.type==="skip") steps=2;
  else if(c.type==="reverse"){
    if(g.players.length===2) steps=2; else steps=1;
    // For reverse in 3+ players, reverse direction isn't persisted in this compact test.
    // It still acts as a turn-skip for a simple mobile test.
    if(g.players.length>2) steps=2;
  }
  advance(g,steps);
  broadcast(r,{type:"sound",name:"card"});
  broadcastState(r);
}
function handleDraw(r,p){
  const g=r.game,gp=gamePlayer(r,p.id);
  if(!g||g.winner||g.players[g.turn]?.id!==p.id) return;
  const count=g.drawStack>0?g.drawStack:1;
  g.drawStack=0;
  drawCards(r,g,gp,count);
  // Drawing is the turn action. If a drawn card is playable, player may use it next turn.
  advance(g,1);
  broadcast(r,{type:"sound",name:"draw"});
  broadcastState(r);
}

wss.on("connection", ws=>{
  const clientId=id();
  ws.send(JSON.stringify({type:"hello",id:clientId}));
  let currentRoom=null;

  ws.on("message", raw=>{
    let m; try{m=JSON.parse(raw);}catch{return;}
    try{
      if(m.type==="create"){
        const username=String(m.username||"").trim().slice(0,18);
        const avatar=m.avatar||"avatar1.jpg";
        if(!username) throw Error("Enter a username.");
        const r={code:code(),hostId:clientId,maxPlayers:6,minCards:10,maxCards:30,players:[],game:null};
        const p={id:clientId,username,ws,avatar:avatar};
        r.players.push(p); rooms.set(r.code,r); currentRoom=r;
        ws.send(JSON.stringify({type:"created",code:r.code}));
        broadcastState(r); return;
      }
      if(m.type==="join"){
        const username=String(m.username||"").trim().slice(0,18);
        const avatar=m.avatar||"avatar1.jpg";
        const r=rooms.get(String(m.code||"").trim().toUpperCase());
        if(!username) throw Error("Enter a username.");
        if(!r) throw Error("Room not found.");
        if(r.game) throw Error("Game already started.");
        if(r.players.length>=r.maxPlayers) throw Error("Room is full.");
        const p={id:clientId,username,ws,avatar:avatar}; r.players.push(p); currentRoom=r;
        ws.send(JSON.stringify({type:"joined",code:r.code}));
        broadcastState(r); return;
      }
      if(!currentRoom) throw Error("Create or join a room first.");
      const r=currentRoom, p=playerOf(r,clientId);
      if(!p) throw Error("Player session not found.");

      if(m.type==="setSettings"){
        if(r.hostId!==clientId||r.game) return;
        r.maxPlayers=[6,8].includes(Number(m.maxPlayers))?Number(m.maxPlayers):6;
        r.minCards=Math.max(10,Math.min(30,Number(m.minCards)||10));
        r.maxCards=Math.max(r.minCards,Math.min(30,Number(m.maxCards)||30));
        broadcastState(r); return;
      }
      if(m.type==="start"){
        if(r.hostId!==clientId) throw Error("Only the host can start.");
        startGame(r); return;
      }
      if(m.type==="end"){
        if(r.hostId!==clientId) throw Error("Only the host can end the game.");
        const winner=r.game?.winner||null;
        r.game=null;
        broadcast(r,{type:"gameEnded",winner});
        // Host stays host after a normal host-initiated end; a future reconnect transfer is handled below.
        broadcastState(r); return;
      }
      if(m.type==="play"){handlePlay(r,p,m);return;}
      if(m.type==="draw"){handleDraw(r,p);return;}
      if(m.type==="uno"){
        const gp=gamePlayer(r,clientId);
        if(gp && gp.hand.length===1){gp.calledUno=true;broadcast(r,{type:"sound",name:"uno"});broadcastState(r);}
        return;
      }
      if(m.type==="emoji"){
        const gp=gamePlayer(r,clientId);
        if(gp) broadcast(r,{type:"emoji",playerId:clientId,emoji:String(m.emoji||"🙂").slice(0,4)});
      }
    }catch(err){
      ws.send(JSON.stringify({type:"error",message:err.message||"Something went wrong."}));
    }
  });

  ws.on("close",()=>{
    if(!currentRoom) return;
    const r=currentRoom,p=playerOf(r,clientId); if(!p) return;
    p.ws=null;
    // If a game is active, keep the player in the room for reconnect.
    // If the game is not active, transfer host immediately so the room remains usable.
    if(!r.game && r.hostId===clientId){
      const next=r.players.find(x=>x.ws);
      if(next){
        r.hostId=next.id;
        broadcast(r,{type:"hostChanged",hostId:next.id,username:next.username});
      }
    }
    broadcastState(r);
  });
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log(`UNO Lounge running on http://0.0.0.0:${PORT}`);
});

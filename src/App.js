import { useState, useRef, useEffect } from "react";

const FIELDS = [
  "RET Serial Number Tag","EDT or RET Value","Sector ID","Base Station ID",
  "Antenna Serial Number Tag","Bearing","Mechanical Tilt","Sector","Technology",
];

const P = {
  primary:"#7F77DD", dark:"#534AB7", light:"#EEEDFE",
  mid:"#AFA9EC", text:"#26215C", border:"#CECBF6",
};

const SECTOR_MAP = {"1":"Alpha","2":"Beta","3":"Gamma","4":"Delta","5":"Epsilon","6":"Zeta"};

function detectSector(stationId, sectorId) {
  const src = ((stationId||"")+" "+(sectorId||"")).toUpperCase();
  for (const s of ["ALPHA","BETA","GAMMA","DELTA","EPSILON","ZETA"]) {
    if (src.includes(s)) return s[0]+s.slice(1).toLowerCase();
  }
  const m = src.match(/_(\d)(?:_|$)/);
  if (m && SECTOR_MAP[m[1]]) return SECTOR_MAP[m[1]];
  return "";
}

function detectTechnology(stationId, freqBand) {
  const sid  = (stationId||"").toUpperCase();
  const freq = (freqBand||"").toUpperCase();
  if (sid.includes("CBRS")) return "CBRS";
  if (sid.includes("C-BAND")||sid.includes("CBAND")) return "C-Band";
  if (sid.includes("LB")||sid.includes("LOWBAND")) return "Lowband";
  if (sid.includes("HB")||sid.includes("HIGHBAND")) return "Highband";
  if (sid.includes("AWS")&&sid.includes("PCS")) return "Highband";
  if (sid.includes("AWS")) return "2100";
  if (sid.includes("PCS")) return "1900LTE";
  if (sid.includes("700")&&sid.includes("850")) return "Lowband";
  if (sid.includes("700")) return "700";
  if (sid.includes("850")) return "850LTE";
  if (freq.includes("3550")||freq.includes("3400")) return "CBRS";
  const hi = freq.includes("1710")||freq.includes("2110")||freq.includes("1850")||freq.includes("1695")||freq.includes("2360");
  const lo = freq.includes("824")||freq.includes("869")||freq.includes("698")||freq.includes("894");
  if (hi&&lo) return "Highband";
  if (hi) return "Highband";
  if (lo) return "Lowband";
  return "";
}

// Safe field extractor from text
function getVal(text, ...keys) {
  for (const key of keys) {
    try {
      const esc = key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s*");
      const m = text.match(new RegExp(esc+"\\s*[:\\[\\]a-z]*\\s*:?\\s*([^\\n\\r]{1,100})","i"));
      if (m) { const v = m[1].replace(/Page\s+\d+\s*\/\s*\d+/gi,"").trim(); if (v) return v; }
    } catch(e) {}
  }
  return "";
}

// ── TXTRPT PARSER ──
function parseTxtrpt(text, fileName) {
  const rows = [];
  const parts = text.split(/(?=^\s*Address\s*:\s*\d+)/im).filter(p=>/Address\s*:\s*\d+/i.test(p));
  for (const block of parts) {
    const g = (...keys) => {
      for (const key of keys) {
        const m = block.match(new RegExp("^"+key+"\\s*:\\s*(.+)$","im"));
        if (m) return m[1].replace(/^="?(.*?)"?$/,"$1").trim();
      }
      return "";
    };
    const addr=g("Address"), station=g("Station ID"), sectorId=g("Sector ID"), freq=g("Antenna Frequency Band");
    rows.push({ fileName, address:addr, data:{
      "RET Serial Number Tag":     g("Device Serial"),
      "EDT or RET Value":          g("Electrical Tilt"),
      "Sector ID":                 sectorId,
      "Base Station ID":           station,
      "Antenna Serial Number Tag": g("Antenna Serial"),
      "Bearing":                   g("Bearing").replace(/\s*degrees?/i,"").trim(),
      "Mechanical Tilt":           g("Mechanical Tilt"),
      "Sector":                    detectSector(station,sectorId),
      "Technology":                detectTechnology(station,freq),
    }});
  }
  return rows;
}

// ── TABRPT PARSER ──
function parseTabrpt(text, fileName) {
  const lines = text.split(/\r?\n/).filter(l=>l.trim());
  if (lines.length<2) return [];
  const headers = lines[0].split("\t").map(h=>h.replace(/^="?(.*?)"?$/,"$1").trim());
  const col = (cols,name) => {
    const i = headers.findIndex(h=>h.toLowerCase()===name.toLowerCase());
    return i>=0 ? (cols[i]||"").replace(/^="?(.*?)"?$/,"$1").trim() : "";
  };
  return lines.slice(1).map((line,i) => {
    const cols=line.split("\t"), station=col(cols,"Station ID"), sectorId=col(cols,"Sector ID");
    const freq=col(cols,"Operating Frequency Band"), bearing=col(cols,"Bearing").replace(/\s*degrees?/i,"").trim();
    return { fileName, address:col(cols,"Address")||String(i+1), data:{
      "RET Serial Number Tag":     col(cols,"Device Serial"),
      "EDT or RET Value":          col(cols,"Elec. Tilt"),
      "Sector ID":                 sectorId,
      "Base Station ID":           station,
      "Antenna Serial Number Tag": col(cols,"Antenna Serial"),
      "Bearing":                   bearing,
      "Mechanical Tilt":           col(cols,"Mech. Tilt"),
      "Sector":                    detectSector(station,sectorId),
      "Technology":                detectTechnology(station,freq),
    }};
  });
}

// ── ALC-ALD PDF PARSER (Ericsson) ──
function parseALCReport(text, fileName) {
  const norm = text.replace(/[ \t]+/g," ");

  // RET Serial — look for "Vendor Code: XX" immediately followed by "Serial Number: YYYY"
  // This handles PDF.js stream where they appear consecutively
  const deviceSection  = norm.split(/Subunit\s*\[/i)[0];
  const subunitSection = norm.includes("Subunit[") ? norm.slice(norm.indexOf("Subunit[")) : norm;

  let retSerial = "";
  // Try combined pattern: Vendor Code + Serial Number close together in device section
  const combinedM = deviceSection.match(/Vendor\s*Code\s*:\s*(\S+)\s+Serial\s*Number\s*:\s*(\S+)/i);
  if (combinedM) {
    retSerial = combinedM[1].trim() + combinedM[2].trim();
  } else {
    // Fallback: Site Overview Unique ID row
    const uniqueM = norm.match(/\d+\s+RET\s+(CP\s*\S+)\s+AISG/i);
    retSerial = uniqueM ? uniqueM[1].replace(/\s+/g,"") : "";
  }

  // Tilt [deg] — from Subunit section
  const tiltM = subunitSection.match(/Tilt\s*\[deg\]\s*:\s*([\d.]+)/i);
  const tilt  = tiltM ? tiltM[1] : "";

  // Sector ID — from Subunit section
  const sectorIdM = subunitSection.match(/Sector\s*ID\s*:\s*(\S+)/i);
  const sectorId  = sectorIdM ? sectorIdM[1].trim() : "";

  // Base Station ID — from Subunit section
  const stationM  = subunitSection.match(/Basestation\s*ID\s*:\s*(\S+)/i);
  const stationId = stationM ? stationM[1].trim() : "";

  // Antenna Serial Number — from Subunit section only
  const antSerialM = subunitSection.match(/Antenna\s*Serial\s*Number\s*:\s*(\S+)/i);
  const antSerial  = antSerialM ? antSerialM[1].trim() : "";

  // Bearing — from Subunit section
  const bearingM = subunitSection.match(/Antenna\s*Bearing\s*\[deg\]\s*:\s*([\d.]+)/i);
  const bearing  = bearingM ? bearingM[1] : "";

  // Mechanical Tilt — from Subunit section
  const mechM    = subunitSection.match(/Mechanical\s*Tilt\s*\[deg\]\s*:\s*([\d.]+)/i);
  const mechTilt = mechM ? mechM[1] : "";

  // Frequency band — from Subunit section
  const freqM    = subunitSection.match(/Antenna\s*Operating\s*Band\s*\[MHz\]\s*:\s*([\d\s.\-–]+)/i);
  const freqBand = freqM ? freqM[1].trim() : "";

  if (!retSerial && !stationId) return [];
  return [{ fileName, address:"1", data:{
    "RET Serial Number Tag":     retSerial,
    "EDT or RET Value":          tilt,
    "Sector ID":                 sectorId,
    "Base Station ID":           stationId,
    "Antenna Serial Number Tag": antSerial,
    "Bearing":                   bearing,
    "Mechanical Tilt":           mechTilt,
    "Sector":                    detectSector(stationId,sectorId),
    "Technology":                detectTechnology(stationId,freqBand),
  }}];
}

// ── COMMSCOPE PDF PARSER ──
function parseCommScopePDF(text, fileName) {
  const norm = text.replace(/[ \t]+/g," ");
  const rows = [];
  const etiltMap = {};
  const etRe = /(CP\S+?)\s+\d+\s+RET\s+OK\s+\S+\s+\S+\s+\S+\s+[\d.]+\s+([\d.]+)/gi;
  let em;
  while ((em=etRe.exec(norm))!==null) etiltMap[em[1]]=em[2];
  const blocks = norm.split(/(?=Configuring Device\s+CP)/i).filter(b=>/Configuring Device\s+CP/i.test(b));
  for (const block of blocks) {
    const titleM = block.match(/Configuring Device\s+(CP\S+?)\s+at\s+Address\s*(\d+)/i);
    if (!titleM) continue;
    const retSerial=titleM[1], address=titleM[2];
    const stationId = getVal(block,"Base Station ID");
    const sectorId  = getVal(block,"Sector ID");
    const freqBand  = getVal(block,"Oper. Band","Oper Band");
    const bearing   = getVal(block,"Bearing").replace(/[^\d.]/g,"");
    const mechTilt  = getVal(block,"Mechanical Tilt").replace(/[^\d.]/g,"");
    const antSerial = getVal(block,"Antenna Serial #","Antenna Serial Number","Antenna Serial");
    let sector="";
    for (const s of ["ALPHA","BETA","GAMMA","DELTA","EPSILON","ZETA"]) {
      if (block.toUpperCase().includes(s)) { sector=s[0]+s.slice(1).toLowerCase(); break; }
    }
    if (!sector) sector=detectSector(stationId,sectorId);
    let tech="";
    const hM=block.match(/(?:ALPHA|BETA|GAMMA|DELTA)\s+(AWS|PCS|LB|CBRS)/i);
    if (hM) {
      const t=hM[1].toUpperCase();
      tech=t==="LB"?"Lowband":t==="AWS"?"2100":t==="PCS"?"1900LTE":"CBRS";
    }
    if (!tech) tech=detectTechnology(stationId,freqBand);
    rows.push({ fileName, address, data:{
      "RET Serial Number Tag":     retSerial,
      "EDT or RET Value":          etiltMap[retSerial]||"",
      "Sector ID":                 sectorId,
      "Base Station ID":           stationId,
      "Antenna Serial Number Tag": antSerial,
      "Bearing":                   bearing,
      "Mechanical Tilt":           mechTilt,
      "Sector":                    sector,
      "Technology":                tech,
    }});
  }
  return rows;
}

function parseFile(text, fileName) {
  const n=fileName.toLowerCase();
  if (n.endsWith(".tabrpt")) return parseTabrpt(text,fileName);
  if (n.endsWith(".pdf")) {
    if (/ALC.*ALD.*Configuration.*Report/i.test(text)) return parseALCReport(text,fileName);
    if (/Configuring\s*Device\s*CP/i.test(text)) return parseCommScopePDF(text,fileName);
    return parseTxtrpt(text,fileName);
  }
  return parseTxtrpt(text,fileName);
}

// ── CSV IMPORT PARSER ──
function parseCSVImport(csv, fileName) {
  const lines=csv.split(/\r?\n/).filter(l=>l.trim());
  if (lines.length<2) return [];
  const headers=lines[0].split(",").map(h=>h.replace(/^"|"$/g,"").trim());
  const col=(cols,...names)=>{
    for (const name of names) {
      const i=headers.findIndex(h=>h.toLowerCase()===name.toLowerCase());
      if (i>=0&&cols[i]) return cols[i].replace(/^"|"$/g,"").replace(/^="?(.*?)"?$/,"$1").trim();
    }
    return "";
  };
  return lines.slice(1).map((line,i)=>{
    const cols=line.split(",");
    const station=col(cols,"Station ID","Base Station ID");
    const sectorId=col(cols,"Sector ID");
    const freq=col(cols,"Operating Frequency Band","Antenna Frequency Band");
    const bearing=col(cols,"Bearing").replace(/\s*degrees?/i,"").trim();
    return { fileName, address:col(cols,"Address")||String(i+1), data:{
      "RET Serial Number Tag":     col(cols,"Device Serial","RET Serial Number Tag"),
      "EDT or RET Value":          col(cols,"Elec. Tilt","EDT or RET Value","Electrical Tilt"),
      "Sector ID":                 sectorId,
      "Base Station ID":           station,
      "Antenna Serial Number Tag": col(cols,"Antenna Serial","Antenna Serial Number Tag"),
      "Bearing":                   bearing,
      "Mechanical Tilt":           col(cols,"Mech. Tilt","Mechanical Tilt"),
      "Sector":                    col(cols,"Sector")||detectSector(station,sectorId),
      "Technology":                col(cols,"Technology")||detectTechnology(station,freq),
    }};
  });
}

function readAsText(file) {
  return new Promise((res,rej)=>{
    const fr=new FileReader();
    fr.onload=e=>res(e.target.result);
    fr.onerror=()=>rej(new Error("Could not read "+file.name));
    fr.readAsText(file,"UTF-8");
  });
}

async function readPDFAsText(file) {
  if (!window.pdfjsLib) throw new Error("PDF.js not ready — please try again.");
  const buf=await file.arrayBuffer();
  const pdf=await window.pdfjsLib.getDocument({data:buf}).promise;
  let out="";
  for (let i=1;i<=pdf.numPages;i++) {
    const page=await pdf.getPage(i);
    const content=await page.getTextContent();
    out+=content.items.map(it=>it.str).join(" ")+"\n";
  }
  if (out.replace(/\s+/g,"").length<50) throw new Error("IMAGE_BASED_PDF");
  return out;
}

function exportCSV(results) {
  const headers=["File Name","Address",...FIELDS];
  const rows=results.map(r=>[r.fileName,r.address,...FIELDS.map(f=>r.data?.[f]??"")]);
  const csv=[headers,...rows].map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob=new Blob([csv],{type:"text/csv"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download="ret_extracted_data.csv"; a.click();
  URL.revokeObjectURL(url);
}

const FileTag=({name})=>{
  const n=(name||"").toLowerCase();
  const [label,bg,color]=n.endsWith(".tabrpt")?["TABRPT","#FBEAF0","#72243E"]:n.endsWith(".txtrpt")?["TXTRPT",P.light,P.dark]:n.endsWith(".pdf")?["PDF","#E6F1FB","#0C447C"]:n.match(/\.(jpg|jpeg|png)/)?["IMG","#FAEEDA","#633806"]:["TXT","#EAF3DE","#27500A"];
  return <span style={{fontSize:10,fontWeight:500,padding:"2px 6px",borderRadius:4,background:bg,color,display:"inline-block",minWidth:44,textAlign:"center"}}>{label}</span>;
};

const SecHead=({icon,title,sub,right})=>(
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 20px",borderBottom:`2px solid ${P.primary}`,background:P.light}}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div style={{width:32,height:32,borderRadius:8,background:P.primary,display:"flex",alignItems:"center",justifyContent:"center"}}>{icon}</div>
      <div>
        <div style={{fontSize:14,fontWeight:500,color:P.text}}>{title}</div>
        <div style={{fontSize:11,color:P.dark,opacity:.7,marginTop:1}}>{sub}</div>
      </div>
    </div>
    {right}
  </div>
);

export default function App() {
  const [files,setFiles]=useState([]);  // refresh
  const [results,setResults]=useState([]);
  const [statuses,setStatuses]=useState({});
  const [dragOver,setDragOver]=useState(false);
  const [imported,setImported]=useState(false);
  const [reviewMode,setReviewMode]=useState(false);
  const [expected,setExpected]=useState([]);
  const fileRef=useRef(), importRef=useRef();

  useEffect(()=>{
    if (!window.XLSX) {
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload=()=>{};
      document.head.appendChild(s);
    }
    if (!window.pdfjsLib) {
      const s=document.createElement("script");
      s.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload=()=>{ window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; };
      document.head.appendChild(s);
    }
  },[]);

  const validExts=[".pdf",".txt",".jpg",".jpeg",".png",".txtrpt",".tabrpt"];
  const addFiles=incoming=>{
    const valid=Array.from(incoming).filter(f=>validExts.some(e=>f.name.toLowerCase().endsWith(e))||f.type.startsWith("image/")||f.type==="application/pdf");
    setFiles(prev=>{const names=new Set(prev.map(f=>f.name)); return [...prev,...valid.filter(f=>!names.has(f.name))];});
  };
  const removeFile=name=>{
    setFiles(p=>p.filter(f=>f.name!==name));
    setResults(p=>p.filter(r=>r.fileName!==name));
    setStatuses(p=>{const n={...p}; delete n[name]; return n;});
  };

  const runExtraction=async()=>{
    const pending=files.filter(f=>!statuses[f.name]||statuses[f.name]==="error");
    if (!pending.length) return;
    setStatuses(prev=>{const n={...prev}; pending.forEach(f=>{n[f.name]="loading";}); return n;});
    const newRows=[];
    for (const file of pending) {
      const n=file.name.toLowerCase();
      const isPDF=n.endsWith(".pdf")||file.type==="application/pdf";
      const isText=n.endsWith(".txtrpt")||n.endsWith(".tabrpt")||n.endsWith(".txt");
      if (isPDF||isText) {
        try {
          const text=isPDF ? await readPDFAsText(file) : await readAsText(file);
          const rows=parseFile(text,file.name);
          if (!rows.length) throw new Error("No data found");
          newRows.push(...rows);
          setStatuses(p=>({...p,[file.name]:"done"}));
        } catch(e) {
          setStatuses(p=>({...p,[file.name]:e.message==="IMAGE_BASED_PDF"?"img_pdf":"error"}));
        }
      } else {
        setStatuses(p=>({...p,[file.name]:"skipped"}));
      }
    }
    setResults(prev=>{const done=new Set(pending.map(f=>f.name)); return [...prev.filter(r=>!done.has(r.fileName)),...newRows];});
  };

  const handleImport=async e=>{
    const file=e.target.files?.[0]; if (!file) return;
    e.target.value="";
    const n=file.name.toLowerCase();
    try {
      if ((n.endsWith(".xlsx")||n.endsWith(".xls"))&&window.XLSX) {
        const buf=await file.arrayBuffer();
        const wb=window.XLSX.read(buf,{type:"array"});
        const csv=window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
        const rows=parseCSVImport(csv,file.name);
        if (!rows.length) { alert("No data found in Excel file."); return; }
        setExpected(rows); setImported(true); setReviewMode(false);
      } else {
        const text=await readAsText(file);
        const rows=n.endsWith(".csv")?parseCSVImport(text,file.name):parseFile(text,file.name);
        if (!rows.length) { alert("No data found."); return; }
        setExpected(rows); setImported(true); setReviewMode(false);
      }
    } catch(err) { alert("Import failed: "+err.message); }
  };

  const getStatus=(fileName,address,field)=>{
    if (!reviewMode) return null;
    const exp=expected.find(e=>e.fileName===fileName&&e.address===address);
    if (!exp) return null;
    const got=results.find(r=>r.fileName===fileName&&r.address===address)?.data?.[field];
    const want=exp.data?.[field];
    if (!got&&!want) return null;
    return (got||"").trim()===(want||"").trim()?"pass":"fail";
  };

  const loadingCount=Object.values(statuses).filter(s=>s==="loading").length;
  const doneCount=Object.values(statuses).filter(s=>s==="done").length;
  const allSt=reviewMode?results.flatMap(r=>FIELDS.map(f=>getStatus(r.fileName,r.address,f))).filter(Boolean):[];
  const passCount=allSt.filter(s=>s==="pass").length;
  const failCount=allSt.filter(s=>s==="fail").length;

  const chip=name=>{
    const s=statuses[name]; if (!s) return null;
    const cfg={loading:["#E6F1FB","#0C447C","processing…"],done:["#EAF3DE","#27500A","done"],error:["#FCEBEB","#A32D2D","error"],skipped:["#F1EFE8","#5F5E5A","skipped"],img_pdf:["#FAEEDA","#633806","image PDF — API required"]};
    const [bg,color,label]=cfg[s]||[]; if (!bg) return null;
    return <span style={{fontSize:11,padding:"2px 8px",borderRadius:99,fontWeight:500,background:bg,color}}>{label}</span>;
  };

  const UpIcon=<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>;
  const TblIcon=<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>;

  return (
    <div style={{padding:"1.5rem 0",maxWidth:1000,margin:"0 auto",fontFamily:"var(--font-sans)"}}>
      <div style={{marginBottom:"1.5rem",paddingBottom:"1rem",borderBottom:`1px solid ${P.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
          <div style={{width:8,height:28,background:P.primary,borderRadius:4}}/>
          <div style={{fontSize:20,fontWeight:500,color:P.text}}>RET parameter extractor</div>
        </div>
        <div style={{fontSize:13,color:P.dark,paddingLeft:18,opacity:.75}}>Supports .txtrpt, .tabrpt, and text-based PDF files</div>
      </div>

      {/* INPUT */}
      <div style={{background:"var(--color-background-primary)",border:`0.5px solid ${P.border}`,borderRadius:"var(--border-radius-lg)",marginBottom:"1.5rem",overflow:"hidden"}}>
        <SecHead icon={UpIcon} title="Input" sub="Drop or browse — .txtrpt, .tabrpt, .pdf, .txt"
          right={files.length>0&&<span style={{fontSize:12,background:P.light,color:P.text,padding:"3px 10px",borderRadius:99,fontWeight:500,border:`0.5px solid ${P.border}`}}>{files.length} file{files.length!==1?"s":""} queued</span>}
        />
        <div style={{padding:"16px 20px"}}>
          <div onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);addFiles(e.dataTransfer.files);}}
            onClick={()=>fileRef.current.click()}
            style={{border:`2px dashed ${dragOver?P.primary:P.mid}`,borderRadius:"var(--border-radius-md)",padding:"28px 20px",textAlign:"center",cursor:"pointer",background:dragOver?P.light:"var(--color-background-secondary)",transition:"background 0.15s, border-color 0.15s",marginBottom:files.length?14:0}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={dragOver?P.primary:P.mid} strokeWidth="1.5" style={{display:"block",margin:"0 auto 10px"}}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div style={{fontSize:14,fontWeight:500,color:dragOver?P.text:"var(--color-text-primary)",marginBottom:4}}>{dragOver?"Drop files here":"Drag & drop files here"}</div>
            <div style={{fontSize:12,color:P.dark,opacity:.6}}>or click to browse — .txtrpt, .tabrpt, .pdf, .txt</div>
          </div>
          <input ref={fileRef} type="file" multiple accept=".txtrpt,.tabrpt,.txt,.pdf,.jpg,.jpeg,.png" style={{display:"none"}} onChange={e=>addFiles(e.target.files)}/>
          {files.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {files.map(f=>(
                <div key={f.name} style={{display:"flex",alignItems:"center",gap:10,background:P.light,borderRadius:"var(--border-radius-md)",padding:"8px 12px",border:`0.5px solid ${P.border}`}}>
                  <FileTag name={f.name}/>
                  <span style={{flex:1,fontSize:13,color:P.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span>
                  <span style={{fontSize:11,color:P.dark,opacity:.6}}>{(f.size/1024).toFixed(0)} KB</span>
                  {chip(f.name)}
                  <button onClick={()=>removeFile(f.name)} style={{background:"none",border:"none",cursor:"pointer",color:P.mid,fontSize:18,lineHeight:1,padding:"0 2px"}}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{padding:"12px 20px",borderTop:`0.5px solid ${P.border}`,background:P.light,display:"flex",gap:10,alignItems:"center",justifyContent:"space-between"}}>
          <button onClick={runExtraction} disabled={!files.length||loadingCount>0}
            style={{padding:"8px 20px",fontSize:13,cursor:files.length&&!loadingCount?"pointer":"not-allowed",opacity:!files.length||loadingCount>0?.45:1,background:files.length&&!loadingCount?P.primary:"transparent",color:files.length&&!loadingCount?"#fff":P.text,border:`0.5px solid ${P.border}`,borderRadius:8}}>
            {loadingCount>0?`Extracting ${loadingCount} file${loadingCount!==1?"s":""}…`:"Extract parameters"}
          </button>
          {files.length>0&&<span style={{fontSize:12,color:P.dark,opacity:.7}}>{files.length} file{files.length!==1?"s":""} ready</span>}
        </div>
      </div>

      {/* OUTPUT */}
      <div style={{background:"var(--color-background-primary)",border:`0.5px solid ${P.border}`,borderRadius:"var(--border-radius-lg)",overflow:"hidden"}}>
        <SecHead icon={TblIcon} title="Extracted results" sub="One row per address block"
          right={results.length>0&&(
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span style={{fontSize:12,background:P.light,color:P.text,padding:"3px 10px",borderRadius:99,fontWeight:500,border:`0.5px solid ${P.border}`}}>{results.length} rows</span>
              <button onClick={()=>exportCSV(results)} style={{padding:"6px 14px",fontSize:12,cursor:"pointer",borderRadius:8,border:`0.5px solid ${P.border}`,background:"transparent",color:P.text}}>Export CSV</button>
            </div>
          )}
        />
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12,padding:"16px 20px",borderBottom:`0.5px solid ${P.border}`}}>
          {[
            {label:"Files processed",val:doneCount},
            {label:"Rows extracted",val:results.length},
            {label:reviewMode?"Passed":"Missing values",val:reviewMode?passCount:results.reduce((a,r)=>a+FIELDS.filter(f=>!r.data?.[f]).length,0),pass:reviewMode&&passCount>0},
            {label:reviewMode?"Failed":"Errors",val:reviewMode?failCount:Object.values(statuses).filter(s=>s==="error").length,fail:reviewMode&&failCount>0},
          ].map((m,i)=>(
            <div key={i} style={{background:m.fail?"#FCEBEB":m.pass?"#EAF3DE":P.light,borderRadius:"var(--border-radius-md)",padding:"10px 14px",border:`0.5px solid ${m.fail?"#F09595":m.pass?"#97C459":P.border}`}}>
              <div style={{fontSize:11,color:m.fail?"#A32D2D":m.pass?"#27500A":P.dark,opacity:.75,marginBottom:4}}>{m.label}</div>
              <div style={{fontSize:20,fontWeight:500,color:m.fail?"#E24B4A":m.pass?"#3B6D11":P.text}}>{m.val}</div>
            </div>
          ))}
        </div>
        <div style={{padding:"12px 20px",borderBottom:`0.5px solid ${P.border}`,background:P.light,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <button onClick={()=>importRef.current.click()}
            style={{display:"flex",alignItems:"center",gap:6,padding:"7px 16px",fontSize:13,cursor:"pointer",borderRadius:8,border:`0.5px solid ${P.border}`,background:imported?P.primary:"transparent",color:imported?"#fff":P.text}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {imported?"Expected values imported":"Import expected values"}
          </button>
          <input ref={importRef} type="file" accept=".xlsx,.xls,.csv,.txtrpt,.tabrpt,.txt" style={{display:"none"}} onChange={handleImport}/>
          {imported&&(
            <button onClick={()=>setReviewMode(r=>!r)}
              style={{display:"flex",alignItems:"center",gap:6,padding:"7px 16px",fontSize:13,cursor:"pointer",borderRadius:8,border:`0.5px solid ${reviewMode?"#97C459":P.border}`,background:reviewMode?"#EAF3DE":"transparent",color:reviewMode?"#27500A":P.text}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              {reviewMode?"Hide review":"Review"}
            </button>
          )}
          {reviewMode&&<span style={{fontSize:12,color:P.dark,opacity:.7}}>Comparing extracted vs expected</span>}
        </div>
        {results.length===0?(
          <div style={{padding:"48px 20px",textAlign:"center"}}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={P.mid} strokeWidth="1" style={{display:"block",margin:"0 auto 12px"}}>
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
            </svg>
            <div style={{fontSize:14,color:P.dark,opacity:.6}}>No results yet — upload files and click Extract</div>
          </div>
        ):(
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{background:P.light}}>
                  <th style={th}>File</th><th style={th}>Addr</th>
                  {FIELDS.map(f=><th key={f} style={th}>{f}</th>)}
                </tr>
              </thead>
              <tbody>
                {results.map((r,i)=>(
                  <tr key={`${r.fileName}-${r.address}-${i}`} style={{background:i%2===0?"transparent":`${P.light}66`}}>
                    <td style={{...td,maxWidth:160}}>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <FileTag name={r.fileName}/>
                        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:11,color:P.text,fontWeight:500}}>{r.fileName}</span>
                      </div>
                    </td>
                    <td style={{...td,textAlign:"center",color:P.dark,fontWeight:500}}>{r.address}</td>
                    {FIELDS.map(f=>{
                      const st=getStatus(r.fileName,r.address,f);
                      const val=r.data?.[f];
                      const expVal=reviewMode?expected.find(e=>e.fileName===r.fileName&&e.address===r.address)?.data?.[f]:null;
                      return (
                        <td key={f} style={td}>
                          <div style={{display:"flex",flexDirection:"column",gap:2}}>
                            <span style={{background:st==="fail"?"#FCEBEB":st==="pass"?"#EAF3DE":P.light,color:st==="fail"?"#A32D2D":st==="pass"?"#27500A":P.text,padding:"2px 7px",borderRadius:4,fontSize:11,fontWeight:500,display:"inline-block"}}>
                              {val||<span style={{opacity:.35}}>—</span>}
                            </span>
                            {st&&<span style={{fontSize:10,fontWeight:500,color:st==="pass"?"#3B6D11":"#A32D2D"}}>{st==="pass"?"✓ PASS":"✗ FAIL"}</span>}
                            {st==="fail"&&expVal&&<span style={{fontSize:10,color:"#A32D2D",opacity:.75}}>exp: {expVal}</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const th={textAlign:"left",padding:"9px 12px",borderBottom:`0.5px solid #CECBF6`,color:"#534AB7",fontWeight:500,whiteSpace:"nowrap",fontSize:11};
const td={padding:"9px 12px",borderBottom:"0.5px solid #EEEDFE",color:"var(--color-text-primary)",verticalAlign:"top",whiteSpace:"nowrap"};
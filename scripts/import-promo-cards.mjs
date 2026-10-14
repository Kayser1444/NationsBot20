// Import reviewed scans; no game rules are generated or inferred by this script.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const root=new URL('../',import.meta.url);
const sharpPath=process.argv.find(value=>value.startsWith('--sharp='))?.slice(8)??'sharp';
const sharp=createRequire(import.meta.url)(sharpPath);
const read=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const catalog=await read('data/cards/catalog.json');
const manifest=await read('data/cards/asset-manifest.json');
const promos=await read('data/cards/promos.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const promo of promos.cards){
 let card=catalog.cards.find(card=>card.id===promo.id);
 if(!card){card={id:promo.id,name:promo.name,aliases:[],imageUrl:null,faqReviewStatus:'pending',metadataSource:'User-supplied promo card scan'};catalog.cards.push(card);}
 if(card.name!==promo.name||card.type&&card.type!==promo.type||card.age&&card.age!==promo.age)throw new Error('Promo metadata mismatch: '+promo.id);
 Object.assign(card,{type:promo.type,age:promo.age,promo:true,tabonyImplemented:false,enabled:true});
 card.aliases=[...new Set([...card.aliases,...promo.aliases])];
 if(!promo.sourceFile)continue;
 const source=await readFile(new URL(promo.sourceFile,root));
 const [left,top,width,height]=promo.crop;
 const input=promo.preparedFile?await readFile(new URL(promo.preparedFile,root)):await sharp(source).extract({left,top,width,height}).png().toBuffer();
 const bytes=await sharp(input).resize(164,254,{fit:'fill',kernel:'lanczos3'}).png().toBuffer();
 const sha256=hash(bytes),filename=card.id+'.'+sha256.slice(0,12)+'.png';
 await writeFile(new URL('public/card-assets/'+filename,root),bytes);
 manifest.files=manifest.files.filter(file=>file.cardId!==card.id);
 manifest.files.push({cardId:card.id,filename,sha256,bytes:bytes.length,width:164,height:254,
  sourceFile:promo.sourceFile,sourceSha256:hash(source),crop:{left,top,width,height},
  cleanupRegions:promo.cleanupRegions,preparedSha256:hash(input),
  provenance:promo.cleanupRegions.length?'User-supplied scan; local watermark cleanup patches from imagegen, original pixels outside those patches retained; resized to library dimensions.':'Original supplied or local card scan; cropped and resized, without generated content.'});
 Object.assign(card,{imageUrl:null,imageCheck:null,imageAsset:filename});
}
catalog.cards.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
manifest.provenance='Printed card crops, resource player boards and reviewed promo scans; source checksums and transformations recorded per file.';
await writeFile(new URL('data/cards/catalog.json',root),JSON.stringify(catalog,null,2)+'\n');
await writeFile(new URL('data/cards/asset-manifest.json',root),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({cards:catalog.cards.length,promos:promos.cards.length,promoImages:promos.cards.filter(card=>card.sourceFile).length,localAssets:manifest.files.length}));

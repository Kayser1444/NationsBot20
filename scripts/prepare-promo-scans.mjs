// Apply only reviewed cleanup patches, preserving every other source pixel.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const sharpPath=process.argv.find(value=>value.startsWith('--sharp='))?.slice(8)??'sharp';
const cleanedSheet=process.argv.find(value=>value.startsWith('--cleaned-sheet='))?.slice(16);
if(!cleanedSheet)throw new Error('Pass --cleaned-sheet=<reviewed imagegen sheet>.');
const sharp=createRequire(import.meta.url)(sharpPath);
const root=new URL('../',import.meta.url);
const specs=JSON.parse(await readFile(new URL('data/cards/promos.json',root),'utf8')).cards;
const generatedRects={
 'promo-imperium-rex':[7,6,336,520], 'promo-potemkin-village':[343,6,335,520],
 'promo-power-grid':[679,6,333,520], 'promo-julius-agricola':[7,527,336,519],
 'promo-engineering-genius':[344,527,333,519], 'promo-solar-eclipse-spring-and-autumn-period':[679,527,333,519],
 'faq-nikola-tesla':[197,1054,308,479], 'faq-hagia-sophia':[506,1054,313,479],
};
const metadata=await sharp(cleanedSheet).metadata();
if(metadata.width!==1019||metadata.height!==1544)throw new Error('Cleanup rectangles require the reviewed 1019×1544 sheet.');
await mkdir(new URL('Reference/promo-scans/prepared/',root),{recursive:true});
for(const spec of specs.filter(card=>card.preparedFile)){
 const [left,top,width,height]=spec.crop;
 const original=await sharp(fileURLToPath(new URL(spec.sourceFile,root))).extract({left,top,width,height}).png().toBuffer();
 const [gl,gt,gw,gh]=generatedRects[spec.id];
 const clean=await sharp(cleanedSheet).extract({left:gl,top:gt,width:gw,height:gh}).resize(width,height,{fit:'fill'}).png().toBuffer();
 const composites=[];
 for(const [pl,pt,pw,ph] of spec.cleanupRegions){
  const patch=await sharp(clean).extract({left:pl,top:pt,width:pw,height:ph}).ensureAlpha().raw().toBuffer();
  for(let y=0;y<ph;y++)for(let x=0;x<pw;x++)patch[(y*pw+x)*4+3]=Math.round(Math.min(1,Math.min(x+1,y+1,pw-x,ph-y)/2)*255);
  composites.push({input:await sharp(patch,{raw:{width:pw,height:ph,channels:4}}).png().toBuffer(),left:pl,top:pt});
 }
 const result=await sharp(original).composite(composites).png().toBuffer();
 const before=await sharp(original).removeAlpha().raw().toBuffer();
 const after=await sharp(result).removeAlpha().raw().toBuffer();
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  if(spec.cleanupRegions.some(([pl,pt,pw,ph])=>x>=pl&&x<pl+pw&&y>=pt&&y<pt+ph))continue;
  const offset=(y*width+x)*3;
  if(!before.subarray(offset,offset+3).equals(after.subarray(offset,offset+3)))throw new Error('Original pixels changed outside cleanup area: '+spec.id);
 }
 await writeFile(new URL(spec.preparedFile,root),result);
}
console.log('Prepared 8 source cards with bounded watermark cleanup patches.');

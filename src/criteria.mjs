import {digest} from './workspace.mjs';
import {excerpt} from './redact.mjs';

// Only the acceptance section has a persistent representation. Plans, paths
// and prompts remain transient; an approval observation binds its exact hash.
export function parsePlanCriteria(plan) {
  const lines=String(plan).split(/\r?\n/);
  const start=lines.findIndex((line)=>/^\s*(?:#{1,6}\s+Acceptance(?: criteria)?\s*:?|\*\*Acceptance(?: criteria)?:?\*\*\s*:?)\s*$/i.test(line));
  if(start<0) return null;
  const criteria=[];
  for(const line of lines.slice(start+1)) {
    if(/^\s*(?:#{1,6}\s|\*\*[^*]+\*\*)/.test(line)) break;
    if(!line.trim()) continue;
    const match=/^\s*[-*]\s+(?:\[([a-z][\w-]*)\]\s+)?(.+?)\s+\((check|manual):\s*([^()]+)\)\s*$/i.exec(line);
    if(!match) throw new Error('Each acceptance item needs observable text and (check: suite-id) or (manual: named review).');
    const [,explicit,text,kind,review]=match;
    if(text.length>500 || excerpt(text,1000)!==text || excerpt(review,1000)!==review) throw new Error('Acceptance text is too long or contains sensitive content; revise it before approval.');
    const item={id:explicit || 'criterion-'+digest(text).slice(0,12),text,...(kind.toLowerCase()==='check'?{check:review.trim()}:{manual:true,review:review.trim()})};
    if(criteria.some((criterion)=>criterion.id===item.id)) throw new Error('Acceptance criterion ids must be unique.');
    criteria.push(item);
  }
  if(!criteria.length || criteria.length>4) throw new Error('An acceptance section needs one to four observable criteria.');
  return criteria;
}

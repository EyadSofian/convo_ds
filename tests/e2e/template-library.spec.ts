import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect,test, type Page } from '@playwright/test';
import { openScreen,setDirection,setTheme } from './support/workspace';
import { CONNECTION } from './support/api';

const axeSource=readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
async function auditLibrary(page:Page){
 await page.evaluate(axeSource);
 const violations=await page.evaluate(async()=>{
  const axe=(window as unknown as {axe:{run:(context:unknown,options:unknown)=>Promise<{violations:{id:string;nodes:{target:string[]}[]}[]}>}}).axe;
  return(await axe.run(document.querySelector('[role=dialog]'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}));
 });
 expect(violations).toEqual([]);
}

test('template team library searches, selects and saves scoped access without losing the preview',async({page})=>{
 await openScreen(page,'channels','?lang=en');
 const id='11111111-aaaa-4111-8111-111111111111';
 const templates=Array.from({length:50},(_,i)=>({id:i===0?id:`template-${i}`,connectionId:CONNECTION,connectionName:'Digital School · Admissions',name:i===0?'course_enquiry_ar':`followup_${i}`,body:i===0?'أهلًا بحضرتك، بنتواصل مع حضرتك بخصوص تسجيل اهتمامك ببرامج البرمجة.':'مساء الخير، مع حضرتك فريق Digital School by Berlitz. يناسب حضرتك نتكلم دلوقتي؟',language:'ar_EG',category:i%2===0?'utility':'marketing',status:'approved',visibility:'all',version:1,teamIds:[]}));
 const teams=[{id:'sales',name:'Sales Team'},{id:'support',name:'Customer Support'}];
 await page.route('**/template-library',route=>route.fulfill({json:{data:{templates,teams},request_id:'library-test'}}));
 let saved:unknown;
 await page.route('**/template-library/access',async route=>{saved=route.request().postDataJSON();await route.fulfill({json:{data:{updated:1},request_id:'saved'}});});
 await page.locator('[data-act="live-template-library-open"]').click();
 const dialog=page.getByRole('dialog');
 await expect(dialog.getByText('50 of 50 templates · 0 selected')).toBeVisible();
 await dialog.locator('[data-form="librarySearch"]').fill('course_enquiry');
 await expect(dialog.locator('.template-library__card')).toHaveCount(1);
 await dialog.getByRole('button',{name:'course_enquiry_ar',exact:true}).click();
 await dialog.getByRole('button',{name:'Selected teams',exact:true}).click();
 await dialog.getByRole('button',{name:'Sales Team',exact:true}).click();
 await page.screenshot({path:'/tmp/omni-template-library-en.png',fullPage:true});
 await auditLibrary(page);
 await dialog.locator('[data-act="live-template-library-save"]').click();
 await expect.poll(()=>saved).toEqual({templates:[{id,version:1}],visibility:'teams',teamIds:['sales']});
 await expect(dialog.getByText('1 of 50 templates · 0 selected')).toBeVisible();
 await dialog.locator('[data-act="close-dialog"]').last().click();
 await setDirection(page,'rtl');await setTheme(page,'dark');
 await page.locator('[data-act="live-template-library-open"]').click();
 await expect(page.locator('.template-library__card')).toHaveCount(50);
 await page.screenshot({path:'/tmp/omni-template-library-ar-dark.png',fullPage:true});
 await auditLibrary(page);
 const viewport=page.viewportSize()!;
 const box=await page.getByRole('dialog').boundingBox();expect(box!.width).toBeLessThanOrEqual(viewport.width);
});

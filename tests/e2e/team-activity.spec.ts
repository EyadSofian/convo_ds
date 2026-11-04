import {expect,test} from '@playwright/test';
import {CONVERSATION,CONNECTION,MEMBERSHIP,installApi} from './support/api';
import {freezeClock,setDirection,setTheme,overflowsHorizontally} from './support/workspace';

test('a read-only inbox shows assignment, authorship and team readers without send or reassignment controls',async({page})=>{
 await freezeClock(page);await installApi(page);
 const conversation={id:CONVERSATION,connectionId:CONNECTION,peerIdentity:'201001234567',contactId:null,contactDisplayName:'Mona Test',teamId:null,assigneeMembershipId:MEMBERSHIP,assigneeName:'Ahmed Ibrahim',status:'open',priority:'normal',version:4,waitingSince:null,inboxLabel:'Digital School',channel:'whatsapp',participantMembershipIds:[],pendingReason:null,snoozedUntil:null,snoozeTimezone:null,resolution:null,resolvedAt:null,lastActivityAt:'2026-09-09T09:15:00Z',ownerState:'human_active',ownerVersion:1,capabilities:{reply:false,note:false,assign:false,handoff:false,close:false}};
 await page.route(/\/api\/v1\/tenants\/[^/]+\/conversations(?:[/?]|$)/,async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/conversations'))return route.fulfill({json:{data:[conversation],pagination:{next_cursor:null,has_more:false}}});
  if(path.endsWith(`/conversations/${CONVERSATION}`))return route.fulfill({json:{data:conversation}});
  if(path.endsWith('/messages'))return route.fulfill({json:{data:[{id:'test-message',direction:'out',at:'2026-09-09T09:15:00Z',content_type:'text',text:'Message from Ahmed',attachments:[],author_membership_id:MEMBERSHIP,author_name:'Ahmed Ibrahim',seen_by:[{membershipId:'reader',name:'Sara Hassan',seenAt:'2026-09-09T09:16:00Z'}],command_state:'provider_accepted',delivery_state:'read',delivery_anomaly:null,provider_message_id:'controlled-id'}],pagination:{next_cursor:null,has_more:false}}});
  return route.fallback();
 });
 await page.goto(`/#/inbox/${CONVERSATION}?lang=en&queue=all`);
 await expect(page.locator('.convrow__assignee').first()).toHaveText('Assigned to Ahmed Ibrahim');
 await expect(page.locator('.msg__author')).toHaveText('Sent by Ahmed Ibrahim');
 await expect(page.locator('.msg__team-seen')).toHaveText('Seen by Sara Hassan');
 await expect(page.locator('.composer--readonly')).toContainText('Read-only');
 await expect(page.locator('[data-act="live-routing-assign"]')).toHaveCount(0);
 await expect(page.locator('.composer textarea')).toHaveCount(0);
 await page.screenshot({path:'/tmp/omni-team-activity-en.png',fullPage:true});
 await setDirection(page,'rtl');await setTheme(page,'dark');
 await expect(page.locator('.msg__author')).toHaveText('أرسلها Ahmed Ibrahim');
 await expect(page.locator('.msg__team-seen')).toHaveText('شاهدها Sara Hassan');
 expect(await overflowsHorizontally(page)).toBe(false);
 await page.screenshot({path:'/tmp/omni-team-activity-ar.png',fullPage:true});
});

test('device alerts activate without a server push key and can be tested immediately',async({page,context})=>{
 await context.grantPermissions(['notifications']);await installApi(page);
 await page.addInitScript(()=>{
  (window as unknown as {testAlerts:string[]}).testAlerts=[];
  // The OS popup is the test boundary; worker activation remains real.
  Object.defineProperty(Notification,'permission',{configurable:true,get:()=> 'granted'});
  Notification.requestPermission=async()=> 'granted';
  ServiceWorkerRegistration.prototype.showNotification=async function(title:string){(window as unknown as {testAlerts:string[]}).testAlerts.push(title);};
 });
 await page.goto('/#/channels?lang=en');await page.locator('.notification-bell').click();
 await expect(page.locator('[data-act="notification-enable-push"]')).toBeEnabled();
 await page.locator('[data-act="notification-enable-push"]').click();
 await expect(page.locator('.notification-menu__push')).toContainText('Browser alerts enabled while the app is open');
 await page.locator('[data-act="notification-test"]').click();
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {testAlerts:string[]}).testAlerts)).toContain('Notification test');
 await page.reload();await page.locator('.notification-bell').click();
 await expect(page.locator('.notification-menu__push')).toContainText('Browser alerts enabled while the app is open');
});

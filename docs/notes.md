# Improvement notes and questions

1. registry health needs to consider redirects. askintegrity.com redirects to https://integrity.com/ask-integrity/ so that config should be ignored
2. https://zip.planenroll.com/ redirects to https://zip.planenroll.com/agent see error below
    ```
    Error: analyse: crawl 31's homepage https://zip.planenroll.com/ returned 301, so reachability has no usable root. Every other page would come out unreachable and every truth-source page an orphan.
    at <anonymous> (/Users/smile.bestybay/smile/link-graph/packages/analyse/src/analyse.ts:158:13)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async withTransaction (/Users/smile.bestybay/smile/link-graph/packages/db/src/pool.ts:57:20)
    at async runCrawlCommand (/Users/smile.bestybay/smile/link-graph/packages/cli/src/run.ts:118:19)
    at async <anonymous> (/Users/smile.bestybay/smile/link-graph/packages/scheduler/src/worker.ts:41:20)
    at async /Users/smile.bestybay/smile/link-graph/node_modules/bullmq/dist/cjs/classes/worker.js:582:32
    ```
3. Are we checking the external links for 404? Where is the view for that in the web package?
4. let's add bull board npx @bull-board/cli -r redis://localhost:6379 to the stack. Great way to see the queue
5. All workers are scheduled for based on WEEKLY_CRON, let's make it run on Sunday.
6. http://localhost:4321/ sites view in the astro home page should have more info, last recent crawl, how many crawls, when will crawl next, etc.
7. Need to flesh out the review flow for orphan pages such that we accept that it is ok for this page to be an orphan
8. I don't really understand these views:  treemap, distributions, section matrix. Need to add more explanation on the page, how they add value, what kind of insight they provide. 
9. Operations doc needs more info on:
    a. npx tsx packages/scheduler/src/bin.ts -- why does it need to keep running? Does it reschedule too?
    b. add bull board info. 
    c. Is there an easier GUI way to explore postgress like Bull Board? I am using vscode https://database-client.com/ extension for now.
10. need to fix the flaky npm ci bug on stack start up
11. Site details page should have also: external links list, all pages list.
12. on the ego page, the table at the bottom has Hop, Path, and Class. Class column name is a bit confusing, let's see if there is a better name or the table needs an explanation header.
13. http://localhost:4321/ sites home page should have a search bar, let's use some react component there to filter the list. Looks like tanstack has something for this. 
14. let's have the astro web also boot up with the docker compose. 
15. wherever there are links to ego network pages, there should also be an option to visit the actual subject page, those links should open in a new tab and have the appropriate icon and aria label stating that it will take to an external link and open in a new window/tab.
16. We need to develop a workflow for debugging failed crawls, maybe some pages need a config that will have ignore links? What is the retry strategy?
17. the astro home page should extent the list to have some states at a glance per website, broken links count, un reviewed orphan links count. That table then should also be sortable by the columns. Will likely use the tanstack's table since we are already using that dependency.
18. we will use claude design with integrity.com design system to make the front end application look nice and presentable. This will be a separate phase towards the end and when the usage limits are reset. 
19. Need to trouble shoot external link check
```
IncompleteLinkcheckError: external link check of crawl 105 is incomplete: not one of the 7 URLs checked produced a usable answer, which is the shape of our own network egress being broken rather than of 7 dead destinations. Nothing was written: recording these as checked would stamp last_checked on all of them and suppress every recheck for a whole TTL window
    at checkExternalUrls (/Users/smile.bestybay/smile/link-graph/packages/linkcheck/src/check.ts:112:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async /Users/smile.bestybay/smile/link-graph/node_modules/bullmq/dist/cjs/classes/worker.js:582:32
```
20. How can I see the currently running crawler?
21. bull board is slow to respond now. Why? could it be because too many schedules or crawls? Memory issue on the machine?
import puppeteer, { Page, Browser } from 'puppeteer'
import treeKill from 'tree-kill';

import blockedHostsList from './blocked-hosts';

import { getDurationInDays, formatDate, getCleanText, getLocationFromText, statusLog, getHostname } from './utils'
import { SessionExpired } from './errors';

export interface Location {
  city: string | null;
  province: string | null;
  country: string | null
}

interface RawProfile {
  fullName: string | null;
  title: string | null;
  location: string | null;
  photo: string | null;
  description: string | null;
  url: string;
}

export interface Profile {
  fullName: string | null;
  title: string | null;
  location: Location | null;
  photo: string | null;
  description: string | null;
  url: string;
}

interface RawExperience {
  title: string | null;
  company: string | null;
  employmentType: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  endDateIsPresent: boolean;
  description: string | null;
}

export interface Experience {
  title: string | null;
  company: string | null;
  employmentType: string | null;
  location: Location | null;
  startDate: string | null;
  endDate: string | null;
  endDateIsPresent: boolean;
  durationInDays: number | null;
  description: string | null;
}

interface RawEducation {
  schoolName: string | null;
  degreeName: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface Education {
  schoolName: string | null;
  degreeName: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
  durationInDays: number | null;
}

interface RawVolunteerExperience {
  title: string | null;
  company: string | null;
  startDate: string | null;
  endDate: string | null;
  endDateIsPresent: boolean;
  description: string | null;
}

export interface VolunteerExperience {
  title: string | null;
  company: string | null;
  startDate: string | null;
  endDate: string | null;
  endDateIsPresent: boolean;
  durationInDays: number | null;
  description: string | null;
}

export interface Skill {
  skillName: string | null;
  endorsementCount: number | null;
}

interface ScraperUserDefinedOptions {
  /**
   * The LinkedIn `li_at` session cookie value. Get this value by logging in to LinkedIn with the account you want to use for scraping.
   * Open your browser's Dev Tools and find the cookie with the name `li_at`. Use that value here.
   * 
   * This script uses a known session cookie of a successful login into LinkedIn, instead of an e-mail and password to set you logged in. 
   * I did this because LinkedIn has security measures by blocking login requests from unknown locations or requiring you to fill in Captcha's upon login.
   * So, if you run this from a server and try to login with an e-mail address and password, your login could be blocked. 
   * By using a known session, we prevent this from happening and allows you to use this scraper on any server on any location.
   * 
   * You probably need to get a new session cookie value when the scraper logs show it's not logged in anymore.
   */
  sessionCookieValue: string;
  /**
   * Set to true if you want to keep the scraper session alive. This results in faster recurring scrapes.
   * But keeps your memory usage high.
   * 
   * Default: `false`
   */
  keepAlive?: boolean;
  /**
   * Set a custom user agent if you like.
   * 
   * Default: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36`
   */
  userAgent?: string;
  /**
   * Use a custom timeout to set the maximum time you want to wait for the scraper 
   * to do his job.
   * 
   * Default: `10000` (10 seconds)
   */
  timeout?: number;
  /**
   * Start the scraper in headless mode, or not.
   * 
   * Default: `true`
   */
  headless?: boolean;
}

interface ScraperOptions {
  sessionCookieValue: string;
  keepAlive: boolean;
  userAgent: string;
  timeout: number;
  headless: boolean;
}

async function autoScroll(page: Page) {
  await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      var totalHeight = 0;
      var distance = 500;
      var timer = setInterval(() => {
        var scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

export class LinkedInProfileScraper {
  readonly options: ScraperOptions = {
    sessionCookieValue: '',
    keepAlive: false,
    timeout: 10000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
    headless: true
  }

  private browser: Browser | null = null;

  constructor(userDefinedOptions: ScraperUserDefinedOptions) {
    const logSection = 'constructing';
    const errorPrefix = 'Error during setup.';

    if (!userDefinedOptions.sessionCookieValue) {
      throw new Error(`${errorPrefix} Option "sessionCookieValue" is required.`);
    }
    
    if (userDefinedOptions.sessionCookieValue && typeof userDefinedOptions.sessionCookieValue !== 'string') {
      throw new Error(`${errorPrefix} Option "sessionCookieValue" needs to be a string.`);
    }
    
    if (userDefinedOptions.userAgent && typeof userDefinedOptions.userAgent !== 'string') {
      throw new Error(`${errorPrefix} Option "userAgent" needs to be a string.`);
    }

    if (userDefinedOptions.keepAlive !== undefined && typeof userDefinedOptions.keepAlive !== 'boolean') {
      throw new Error(`${errorPrefix} Option "keepAlive" needs to be a boolean.`);
    }
   
    if (userDefinedOptions.timeout !== undefined && typeof userDefinedOptions.timeout !== 'number') {
      throw new Error(`${errorPrefix} Option "timeout" needs to be a number.`);
    }
    
    if (userDefinedOptions.headless !== undefined && typeof userDefinedOptions.headless !== 'boolean') {
      throw new Error(`${errorPrefix} Option "headless" needs to be a boolean.`);
    }

    this.options = Object.assign(this.options, userDefinedOptions);

    statusLog(logSection, `Using options: ${JSON.stringify(this.options)}`);
  }

  /**
   * Method to load Puppeteer in memory so we can re-use the browser instance.
   */
  public setup = async () => {
    const logSection = 'setup'

    try {
      statusLog(logSection, `Launching puppeteer in the ${this.options.headless ? 'background' : 'foreground'}...`)

      this.browser = await puppeteer.launch({
        headless: this.options.headless,
        args: [
          ...(this.options.headless ? '---single-process' : '---start-maximized'),
          '--no-sandbox',
          '--disable-setuid-sandbox',
          "--proxy-server='direct://",
          '--proxy-bypass-list=*',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-features=site-per-process',
          '--enable-features=NetworkService',
          '--allow-running-insecure-content',
          '--enable-automation',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-web-security',
          '--autoplay-policy=user-gesture-required',
          '--disable-background-networking',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-domain-reliability',
          '--disable-extensions',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-notifications',
          '--disable-offer-store-unmasked-wallet-cards',
          '--disable-popup-blocking',
          '--disable-print-preview',
          '--disable-prompt-on-repost',
          '--disable-speech-api',
          '--disable-sync',
          '--disk-cache-size=33554432',
          '--hide-scrollbars',
          '--ignore-gpu-blacklist',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-first-run',
          '--no-pings',
          '--no-zygote',
          '--password-store=basic',
          '--use-gl=swiftshader',
          '--use-mock-keychain'
        ],
        timeout: this.options.timeout
      })

      statusLog(logSection, 'Puppeteer launched!')

      await this.checkIfLoggedIn();

      statusLog(logSection, 'Done!')
    } catch (err) {
      // Kill Puppeteer
      await this.close();

      statusLog(logSection, 'An error occurred during setup.')

      throw err
    }
  };

  /**
   * Create a Puppeteer page with some extra settings to speed up the crawling process.
   */
  private createPage = async (): Promise<Page> => {
    const logSection = 'setup page'

    if (!this.browser) {
      throw new Error('Browser not set.');
    }

    // Important: Do not block "stylesheet", makes the crawler not work for LinkedIn
    const blockedResources = ['image', 'media', 'font', 'texttrack', 'object', 'beacon', 'csp_report', 'imageset'];

    try {
      const page = await this.browser.newPage()

      // Use already open page
      // This makes sure we don't have an extra open tab consuming memory
      const firstPage = (await this.browser.pages())[0];
      await firstPage.close();

      // Method to create a faster Page
      // From: https://github.com/shirshak55/scrapper-tools/blob/master/src/fastPage/index.ts#L113
      const session = await page.target().createCDPSession()
      await page.setBypassCSP(true)
      await session.send('Page.enable');
      await session.send('Page.setWebLifecycleState', {
        state: 'active',
      });

      statusLog(logSection, `Blocking the following resources: ${blockedResources.join(', ')}`)

      // A list of hostnames that are trackers
      // By blocking those requests we can speed up the crawling
      // This is kinda what a normal adblocker does, but really simple
      const blockedHosts = this.getBlockedHosts();
      const blockedResourcesByHost = ['script', 'xhr', 'fetch', 'document']

      statusLog(logSection, `Should block scripts from ${Object.keys(blockedHosts).length} unwanted hosts to speed up the crawling.`);

      // Block loading of resources, like images and css, we dont need that
      await page.setRequestInterception(true);

      page.on('request', (req) => {
        if (blockedResources.includes(req.resourceType())) {
          return req.abort()
        }

        const hostname = getHostname(req.url());

        // Block all script requests from certain host names
        if (blockedResourcesByHost.includes(req.resourceType()) && hostname && blockedHosts[hostname] === true) {
          statusLog('blocked script', `${req.resourceType()}: ${hostname}: ${req.url()}`);
          return req.abort();
        }

        return req.continue()
      })

      await page.setUserAgent(this.options.userAgent)

      await page.setViewport({
        width: 1200,
        height: 720
      })

      statusLog(logSection, `Setting session cookie using cookie: ${process.env.LINKEDIN_SESSION_COOKIE_VALUE}`)

      await page.setCookie({
        'name': 'li_at',
        'value': this.options.sessionCookieValue,
        'domain': '.www.linkedin.com'
      })

      statusLog(logSection, 'Session cookie set!')

      statusLog(logSection, 'Done!')

      return page;
    } catch (err) {
      // Kill Puppeteer
      await this.close();

      statusLog(logSection, 'An error occurred during page setup.')
      statusLog(logSection, err.message)

      throw err
    }
  };

  /**
   * Method to block know hosts that have some kind of tracking.
   * By blocking those hosts we speed up the crawling.
   * 
   * More info: http://winhelp2002.mvps.org/hosts.htm
   */
  private getBlockedHosts = (): object => {
    const blockedHostsArray = blockedHostsList.split('\n');

    let blockedHostsObject = blockedHostsArray.reduce((prev, curr) => {
      const frags = curr.split(' ');

      if (frags.length > 1 && frags[0] === '0.0.0.0') {
        prev[frags[1].trim()] = true;
      }

      return prev;
    }, {});

    blockedHostsObject = {
      ...blockedHostsObject,
      'static.chartbeat.com': true,
      'scdn.cxense.com': true,
      'api.cxense.com': true,
      'www.googletagmanager.com': true,
      'connect.facebook.net': true,
      'platform.twitter.com': true,
      'tags.tiqcdn.com': true,
      'dev.visualwebsiteoptimizer.com': true,
      'smartlock.google.com': true,
      'cdn.embedly.com': true
    }

    return blockedHostsObject;
  }

  /**
   * Method to complete kill any Puppeteer process still active.
   * Freeing up memory.
   */
  public close = (page?: Page): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      const loggerPrefix = 'close';

      if (page) {
        try {
          statusLog(loggerPrefix, 'Closing page...');
          await page.close();
          statusLog(loggerPrefix, 'Closed page!');
        } catch (err) {
          reject(err)
        }
      }

      if (this.browser) {
        try {
          statusLog(loggerPrefix, 'Closing browser...');
          await this.browser.close();
          statusLog(loggerPrefix, 'Closed browser!');

          const browserProcessPid = this.browser.process().pid;

          // Completely kill the browser process to prevent zombie processes
          // https://docs.browserless.io/blog/2019/03/13/more-observations.html#tip-2-when-you-re-done-kill-it-with-fire
          if (browserProcessPid) {
            statusLog(loggerPrefix, `Killing browser process pid: ${browserProcessPid}...`);

            treeKill(browserProcessPid, 'SIGKILL', (err) => {
              if (err) {
                return reject(`Failed to kill browser process pid: ${browserProcessPid}`);
              }

              statusLog(loggerPrefix, `Killed browser pid: ${browserProcessPid} Closed browser.`);
              resolve()
            });
          }
        } catch (err) {
          reject(err);
        }
      }

      return resolve()
    })

  }

  /**
   * Simple method to check if the session is still active.
   */
  public checkIfLoggedIn = async () => {
    const logSection = 'checkIfLoggedIn';

    const page = await this.createPage();

    statusLog(logSection, 'Checking if we are still logged in...')

    // Go to the login page of LinkedIn
    // If we do not get redirected and stay on /login, we are logged out
    // If we get redirect to /feed, we are logged in
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'networkidle2',
      timeout: this.options.timeout
    })

    const url = page.url()

    const isLoggedIn = !url.endsWith('/login')

    await page.close();

    if (isLoggedIn) {
      statusLog(logSection, 'All good. We are still logged in.')
    } else {
      const errorMessage = 'Bad news, we are not logged in! Your session seems to be expired. Use your browser to login again with your LinkedIn credentials and extract the "li_at" cookie value for the "sessionCookieValue" option.';
      statusLog(logSection, errorMessage)
      throw new SessionExpired(errorMessage)
    }
  };

  /**
   * Method to scrape a user profile.
   */
  public run = async (profileUrl: string) => {
    const logSection = 'run'

    const scraperSessionId = new Date().getTime();

    if (!this.browser) {
      throw new Error('Browser is not set. Please run the setup method first.')
    }

    if (!profileUrl) {
      throw new Error('No profileUrl given.')
    }

    if (!profileUrl.includes('linkedin.com/')) {
      throw new Error('The given URL to scrape is not a linkedin.com url.')
    }

    try {
      // Eeach run has it's own page
      const page = await this.createPage();

      statusLog(logSection, `Navigating to LinkedIn profile: ${profileUrl}`, scraperSessionId)

      await page.goto(profileUrl, {
        // Use "networkidl2" here and not "domcontentloaded". 
        // As with "domcontentloaded" some elements might not be loaded correctly, resulting in missing data.
        waitUntil: 'networkidle2',
        timeout: this.options.timeout
      });

      statusLog(logSection, 'LinkedIn profile page loaded!', scraperSessionId)

      statusLog(logSection, 'Getting all the LinkedIn profile data by scrolling the page to the bottom, so all the data gets loaded into the page...', scraperSessionId)

      await autoScroll(page);

      statusLog(logSection, 'Parsing data...', scraperSessionId)

      // Only click the expanding buttons when they exist
      const expandButtonsSelectors = [
        '.pv-profile-section.pv-about-section .lt-line-clamp__more', // About
        '#experience-section .pv-profile-section__see-more-inline.link', // Experience
        '.pv-profile-section.education-section button.pv-profile-section__see-more-inline', // Education
        '.pv-skill-categories-section [data-control-name="skill_details"]', // Skills
      ];

      const seeMoreButtonsSelectors = ['.pv-entity__description .lt-line-clamp__line.lt-line-clamp__line--last .lt-line-clamp__more[href="#"]', '.lt-line-clamp__more[href="#"]:not(.lt-line-clamp__ellipsis--dummy)']

      statusLog(logSection, 'Expanding all sections by clicking their "See more" buttons', scraperSessionId)

      for (const buttonSelector of expandButtonsSelectors) {
        try {
          if (await page.$(buttonSelector) !== null) {
            statusLog(logSection, `Clicking button ${buttonSelector}`, scraperSessionId)
            await page.click(buttonSelector);
          }
        } catch (err) {
          statusLog(logSection, `Could not find or click expand button selector "${buttonSelector}". So we skip that one.`, scraperSessionId)
        }
      }
      

      // To give a little room to let data appear. Setting this to 0 might result in "Node is detached from document" errors
      await page.waitFor(100);

      statusLog(logSection, 'Expanding all descriptions by clicking their "See more" buttons', scraperSessionId)

      for (const seeMoreButtonSelector of seeMoreButtonsSelectors) {
        const buttons = await page.$$(seeMoreButtonSelector)

        for (const button of buttons) {
          if (button) {
            try {
              statusLog(logSection, `Clicking button ${seeMoreButtonSelector}`, scraperSessionId)
              await button.click()
            } catch (err) {
              statusLog(logSection, `Could not find or click see more button selector "${button}". So we skip that one.`, scraperSessionId)
            }
          }
        }
      }

      statusLog(logSection, 'Parsing profile data...', scraperSessionId)

      const rawUserProfileData: RawProfile = await page.evaluate(() => {
        const profileSection = document.querySelector('.pv-top-card')

        const url = window.location.href

        const fullNameElement = profileSection?.querySelector('.pv-top-card--list li:first-child')
        const fullName = fullNameElement?.textContent || null

        const titleElement = profileSection?.querySelector('h2')
        const title = titleElement?.textContent || null

        const locationElement = profileSection?.querySelector('.pv-top-card--list.pv-top-card--list-bullet.mt1 li:first-child')
        const location = locationElement?.textContent || null

        const photoElement = profileSection?.querySelector('.pv-top-card__photo') || profileSection?.querySelector('.profile-photo-edit__preview')
        const photo = photoElement?.getAttribute('src') || null

        const descriptionElement = document.querySelector('.pv-about__summary-text .lt-line-clamp__raw-line') // Is outside "profileSection"
        const description = descriptionElement?.textContent || null

        return {
          fullName,
          title,
          location,
          photo,
          description,
          url
        } as RawProfile
      })

      // Convert the raw data to clean data using our utils
      // So we don't have to inject our util methods inside the browser context, which is too damn difficult using TypeScript
      const userProfile: Profile = {
        ...rawUserProfileData,
        fullName: getCleanText(rawUserProfileData.fullName),
        title: getCleanText(rawUserProfileData.title),
        location: rawUserProfileData.location ? getLocationFromText(rawUserProfileData.location) : null,
        description: getCleanText(rawUserProfileData.description),
      }

      statusLog(logSection, `Got user profile data: ${JSON.stringify(userProfile)}`, scraperSessionId)

      statusLog(logSection, `Parsing experiences data...`, scraperSessionId)

      const rawExperiencesData: RawExperience[] = await page.$$eval('#experience-section ul > .ember-view', (nodes) => {
        let data: RawExperience[] = []

        // Using a for loop so we can use await inside of it
        for (const node of nodes) {
          const titleElement = node.querySelector('h3');
          const title = titleElement?.textContent || null

          const employmentTypeElement = node.querySelector('span.pv-entity__secondary-title');
          const employmentType = employmentTypeElement?.textContent || null

          const companyElement = node.querySelector('.pv-entity__secondary-title');
          const companyElementClean = companyElement && companyElement?.querySelector('span') ? companyElement?.removeChild(companyElement.querySelector('span') as Node) && companyElement : companyElement || null;
          const company = companyElementClean?.textContent || null

          const descriptionElement = node.querySelector('.pv-entity__description');
          const description = descriptionElement?.textContent || null

          const dateRangeElement = node.querySelector('.pv-entity__date-range span:nth-child(2)');
          const dateRangeText = dateRangeElement?.textContent || null

          const startDatePart = dateRangeText?.split('–')[0] || null;
          const startDate = startDatePart?.trim() || null;

          const endDatePart = dateRangeText?.split('–')[1] || null;
          const endDateIsPresent = endDatePart?.trim().toLowerCase() === 'present' || false;
          const endDate = (endDatePart && !endDateIsPresent) ? endDatePart.trim() : 'Present';

          const locationElement = node.querySelector('.pv-entity__location span:nth-child(2)');
          const location = locationElement?.textContent || null;

          data.push({
            title,
            company,
            employmentType,
            location,
            startDate,
            endDate,
            endDateIsPresent,
            description
          })
        }

        return data;
      });

      // Convert the raw data to clean data using our utils
      // So we don't have to inject our util methods inside the browser context, which is too damn difficult using TypeScript
      const experiences: Experience[] = rawExperiencesData.map((rawExperience) => {
        const startDate = formatDate(rawExperience.startDate);
        const endDate = formatDate(rawExperience.endDate) || null;
        const endDateIsPresent = rawExperience.endDateIsPresent;

        const durationInDaysWithEndDate = (startDate && endDate && !endDateIsPresent) ? getDurationInDays(startDate, endDate) : null
        const durationInDaysForPresentDate = (endDateIsPresent && startDate) ? getDurationInDays(startDate, new Date()) : null
        const durationInDays = endDateIsPresent ? durationInDaysForPresentDate : durationInDaysWithEndDate;

        return {
          ...rawExperience,
          title: getCleanText(rawExperience.title),
          company: getCleanText(rawExperience.company),
          employmentType: getCleanText(rawExperience.employmentType),
          location: rawExperience?.location ? getLocationFromText(rawExperience.location) : null,
          startDate,
          endDate,
          endDateIsPresent,
          durationInDays,
          description: getCleanText(rawExperience.description)
        }
      })

      statusLog(logSection, `Got experiences data: ${JSON.stringify(experiences)}`, scraperSessionId)

      statusLog(logSection, `Parsing education data...`, scraperSessionId)

      const rawEducationData: RawEducation[] = await page.$$eval('#education-section ul > .ember-view', (nodes) => {
        // Note: the $$eval context is the browser context.
        // So custom methods you define in this file are not available within this $$eval.
        let data: RawEducation[] = []
        for (const node of nodes) {

          const schoolNameElement = node.querySelector('h3.pv-entity__school-name');
          const schoolName = schoolNameElement?.textContent || null;

          const degreeNameElement = node.querySelector('.pv-entity__degree-name .pv-entity__comma-item');
          const degreeName = degreeNameElement?.textContent || null;

          const fieldOfStudyElement = node.querySelector('.pv-entity__fos .pv-entity__comma-item');
          const fieldOfStudy = fieldOfStudyElement?.textContent || null;

          // const gradeElement = node.querySelector('.pv-entity__grade .pv-entity__comma-item');
          // const grade = (gradeElement && gradeElement.textContent) ? window.getCleanText(fieldOfStudyElement.textContent) : null;

          const dateRangeElement = node.querySelectorAll('.pv-entity__dates time');

          const startDatePart = dateRangeElement && dateRangeElement[0]?.textContent || null;
          const startDate = startDatePart || null

          const endDatePart = dateRangeElement && dateRangeElement[1]?.textContent || null;
          const endDate = endDatePart || null

          data.push({
            schoolName,
            degreeName,
            fieldOfStudy,
            startDate,
            endDate
          })
        }

        return data
      });

      // Convert the raw data to clean data using our utils
      // So we don't have to inject our util methods inside the browser context, which is too damn difficult using TypeScript
      const education: Education[] = rawEducationData.map(rawEducation => {
        const startDate = formatDate(rawEducation.startDate)
        const endDate = formatDate(rawEducation.endDate)

        return {
          ...rawEducation,
          schoolName: getCleanText(rawEducation.schoolName),
          degreeName: getCleanText(rawEducation.degreeName),
          fieldOfStudy: getCleanText(rawEducation.fieldOfStudy),
          startDate,
          endDate,
          durationInDays: getDurationInDays(startDate, endDate),
        }
      })

      statusLog(logSection, `Got education data: ${JSON.stringify(education)}`, scraperSessionId)

      statusLog(logSection, `Parsing volunteer experience data...`, scraperSessionId)

      const rawVolunteerExperiences: RawVolunteerExperience[] = await page.$$eval('.pv-profile-section.volunteering-section ul > li.ember-view', (nodes) => {
        // Note: the $$eval context is the browser context.
        // So custom methods you define in this file are not available within this $$eval.
        let data: RawVolunteerExperience[] = []
        for (const node of nodes) {

          const titleElement = node.querySelector('.pv-entity__summary-info h3');
          const title = titleElement?.textContent || null;
          
          const companyElement = node.querySelector('.pv-entity__summary-info span.pv-entity__secondary-title');
          const company = companyElement?.textContent || null;

          const dateRangeElement = node.querySelector('.pv-entity__date-range span:nth-child(2)');
          const dateRangeText = dateRangeElement?.textContent || null
          const startDatePart = dateRangeText?.split('–')[0] || null;
          const startDate = startDatePart?.trim() || null;

          const endDatePart = dateRangeText?.split('–')[1] || null;
          const endDateIsPresent = endDatePart?.trim().toLowerCase() === 'present' || false;
          const endDate = (endDatePart && !endDateIsPresent) ? endDatePart.trim() : 'Present';

          const descriptionElement = node.querySelector('.pv-entity__description')
          const description = descriptionElement?.textContent || null;

          data.push({
            title,
            company,
            startDate,
            endDate,
            endDateIsPresent,
            description
          })
        }

        return data
      });

      // Convert the raw data to clean data using our utils
      // So we don't have to inject our util methods inside the browser context, which is too damn difficult using TypeScript
      const volunteerExperiences: VolunteerExperience[] = rawVolunteerExperiences.map(rawVolunteerExperience => {
        const startDate = formatDate(rawVolunteerExperience.startDate)
        const endDate = formatDate(rawVolunteerExperience.endDate)

        return {
          ...rawVolunteerExperience,
          title: getCleanText(rawVolunteerExperience.title),
          company: getCleanText(rawVolunteerExperience.company),
          description: getCleanText(rawVolunteerExperience.description),
          startDate,
          endDate,
          durationInDays: getDurationInDays(startDate, endDate),
        }
      })

      statusLog(logSection, `Got volunteer experience data: ${JSON.stringify(volunteerExperiences)}`, scraperSessionId)

      statusLog(logSection, `Parsing skills data...`, scraperSessionId)

      const skills: Skill[] = await page.$$eval('.pv-skill-categories-section ol > .ember-view', nodes => {
        // Note: the $$eval context is the browser context.
        // So custom methods you define in this file are not available within this $$eval.

        return nodes.map((node) => {
          const skillName = node.querySelector('.pv-skill-category-entity__name-text');
          const endorsementCount = node.querySelector('.pv-skill-category-entity__endorsement-count');

          return {
            skillName: (skillName) ? skillName.textContent?.trim() : null,
            endorsementCount: (endorsementCount) ? parseInt(endorsementCount.textContent?.trim() || '0') : 0
          } as Skill;
        }) as Skill[]
      });

      statusLog(logSection, `Got skills data: ${JSON.stringify(skills)}`, scraperSessionId)

      statusLog(logSection, `Done! Returned profile details for: ${profileUrl}`, scraperSessionId)

      if (!this.options.keepAlive) {
        statusLog(logSection, 'Not keeping the session alive.')

        await this.close(page)

        statusLog(logSection, 'Done. Puppeteer is closed.')
      } else {
        statusLog(logSection, 'Done. Puppeteer is being kept alive in memory.')

        // Only close the current page, we do not need it anymore
        await page.close()
      }

      return {
        userProfile,
        experiences,
        education,
        volunteerExperiences,
        skills
      }
    } catch (err) {
      // Kill Puppeteer
      await this.close()

      statusLog(logSection, 'An error occurred during a run.')

      // Throw the error up, allowing the user to handle this error himself.
      throw err;
    }
  }
}

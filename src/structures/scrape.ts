import puppeteer from "puppeteer";
import { logger } from "../config/pino.js";
import { EventEmitter } from "events";
import dayjs from "dayjs";
import weekday from "dayjs/plugin/weekday.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import {
	AssignmentDetails,
	MissingAssignmentDetails,
	ScheduleDetails,
} from "../index.js";
import { RequestedList, ScraperStatus } from "../types/scraper.js";
// @ts-expect-error The module is not typed
import Cronitor from "cronitor";
import {
	AssignmentError,
	AssignmentRequestResult,
} from "../types/assignment.js";
const cronitor = new Cronitor();

dayjs.extend(weekday);

export class TokenGrabber extends EventEmitter {
	public token: string | boolean;
	public browser: puppeteer.Browser | undefined;
	public page: puppeteer.Page | undefined;
	public status: keyof typeof ScraperStatus;
	private monitor = new cronitor.Monitor("Get API Token");
	public constructor() {
		super();
		this.token = "";
		this.status = "IDLE";
		this.setStatus("INITIALIZING");
		this.getToken();
	}

	public async setStatus(status: keyof typeof ScraperStatus) {
		this.status = status;
		this.emit(status);
	}

	public getStatus(): keyof typeof ScraperStatus {
		return this.status;
	}

	public async destroy(): Promise<void> {
		await this.monitor.ping({
			state: "complete",
			message: "Token Grabber destroyed",
		});
	}

	public async getAssignments(
		retries = 5
	): Promise<AssignmentDetails[] | undefined> {
		try {
			this.setStatus("REQUESTING_ASSIGNMENTS");
			const assignments = await this.requestList("ASSIGNMENTS");
			this.setStatus("IDLE");
			return assignments as AssignmentDetails[] | undefined;
		} catch (err) {
			logger.error(
				err,
				"Failed to get assignments, grabbing token again and retrying..."
			);

			if (retries > 0) {
				await this.getToken();
				await this.getAssignments(retries - 1);
			} else {
				logger.error("All attempts failed");
				process.exit(1);
			}
		}
	}

	public async getMissing(
		retries = 5
	): Promise<MissingAssignmentDetails[] | undefined> {
		try {
			this.setStatus("REQUESTING_MISSING");
			const missingAssignment = await this.requestList("MISSING");
			this.setStatus("IDLE");
			return missingAssignment as MissingAssignmentDetails[] | undefined;
		} catch (err) {
			logger.error(
				err,
				"Failed to get missing assignments, grabbing token again and retrying..."
			);

			if (retries > 0) {
				await this.getToken();
				await this.getMissing(retries - 1);
			} else {
				logger.fatal("All attempts failed");
				process.exit(1);
			}
		}
	}

	public async getSchedule(
		retries = 5
	): Promise<ScheduleDetails[] | undefined> {
		try {
			this.setStatus("REQUESTING_SCHEDULE");
			const schedule = await this.requestList("SCHEDULE");
			this.setStatus("IDLE");
			return schedule as ScheduleDetails[] | undefined;
		} catch (err) {
			logger.error(
				err,
				"Failed to get schedule, grabbing token again and retrying..."
			);

			if (retries > 0) {
				await this.getToken();
				await this.getSchedule(retries - 1);
			} else {
				logger.fatal("All attempts failed");
				process.exit(1);
			}
		}
	}

	public async requestList(
		type: keyof typeof RequestedList
	): Promise<AssignmentRequestResult> {
		// eslint-disable-next-line no-async-promise-executor
		return new Promise(async (resolve, reject): Promise<void> => {
			try {
				let url = "";

				switch (type) {
				case "ASSIGNMENTS":
					url = this.generateAssignmentUrl();
					break;
				case "SCHEDULE":
					url = this.generateScheduleUrl();
					break;
				case "MISSING":
					url = this.generateMissingUrl();
					break;
				default:
					throw new Error("Invalid list type");
				}

				const response = await fetch(url);
				const jsonResult = (await response.json()) as {
					[key: string]: string | number;
				};

				if (jsonResult.ErrorType) {
					reject(jsonResult as unknown as AssignmentError);
				}

				resolve(jsonResult as unknown as AssignmentRequestResult);
			} catch (err: unknown) {
				reject(err);
			}
		});
	}

	public generateMissingUrl() {
		const baseUrl = `${process.env.BASE_URL}/api/DataDirect/StudentMissingAssignmentList`;
		const studentId = process.env.STUDENT_ID;
		const t = this.token;

		return `${baseUrl}?studentId=${studentId}&t=${t}`;
	}

	public generateAssignmentUrl() {
		const baseUrl = `${process.env.BASE_URL}/api/mycalendar/assignments`;
		const startDate = dayjs().weekday(0).format("MM/DD/YYYY");
		const endDate = dayjs().add(3, "month").format("MM/DD/YYYY");
		const t = this.token;

		return `${baseUrl}?t=${t}&startDate=${startDate}&endDate=${endDate}&filterString=${process.env.FILTERSTRING}&recentSave=false`;
	}

	public generateScheduleUrl() {
		const baseUrl = `${process.env.BASE_URL}/api/mycalendar/schedule`;
		const startDate = dayjs().weekday(0).format("MM/DD/YYYY");
		const endDate = dayjs().add(3, "month").format("MM/DD/YYYY");
		const t = this.token;

		const scheduleString = "5023647_2";
		const recentSave = false;
		return `${baseUrl}?startDate=${startDate}&endDate=${endDate}&t=${t}&scheduleString=${scheduleString}&recentSave=${recentSave}`;
	}

	public async getToken(retries = 5) {
		try {
			logger.info("Requesting a new token token");
			this.setStatus("REQUESTING_TOKEN");
			await this.monitor.ping({ state: "run" });
			this.token = await this.login();
			this.emit("ready", this.token);
			await this.monitor.ping({ state: "complete" });
			this.setStatus("IDLE");
			logger.info("Token request complete");
			return this.token;
		} catch (err) {
			logger.error(err, "Failed to get token, retrying...");
			await this.monitor.ping({ state: "fail" });

			// take screenshot of error
			try {
				await this.page?.screenshot({
					path: `./public/errors/error_${dayjs().format(
						"YYYY-MM-DD-HH-MM-SS"
					)}.png`,
				});
				await this.browser?.close();
			} catch (err) {
				logger.error(err, "Failed to take screenshot");
				await this.browser?.close();
			}

			// retry
			if (retries > 0) {
				await this.getToken(retries - 1);
			} else {
				logger.error("All attempts failed");
				process.exit(1);
			}
		}
	}

	public login(): Promise<string> {
		// eslint-disable-next-line no-async-promise-executor
		return new Promise(async (resolve, reject) => {
			try {
				this.browser = await puppeteer.launch({
					headless: true,
					handleSIGINT: true,
					args: ["--use-gl=egl"],
				});
				this.page = await this.browser.newPage();

				this.page.setDefaultTimeout(10000000);

				await this.page.goto(process.env.BASE_URL || "");
				logger.info("Connected to CORE");
				await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 });

				// login on core page
				logger.info("Entering username into CORE");
				await this.page.waitForSelector("#site-login-input .textfield INPUT");
				await this.page.waitForSelector(".btn-primary");
				logger.info("Found username input, waiting 1 second");
				await this.page.waitForTimeout(1000);
				logger.trace("Wait complete, entering username");
				await this.page.type(
					"#site-login-input .textfield INPUT",
					process.env.EMAIL || ""
				);
				await this.page.click(".btn-primary");
				logger.info("Username entered and clicked login button");
				await this.page.waitForNavigation();

				// google email login
				logger.info("Beginning Google login");
				await this.page.waitForSelector(".signin-card input[type=\"submit\"]");
				logger.info("Found Google login button, waiting 1 second..");
				await this.page.waitForTimeout(1000);
				logger.trace("Wait complete, clicking Google login button");
				await this.page.click(".signin-card input[type=\"submit\"]");
				logger.info("Google login button clicked");

				// google password section
				logger.info("Waiting for password input");
				await this.page.waitForSelector("input#password.mCAa0e");
				await this.page.waitForSelector("input#submit.MK9CEd.MVpUfe");
				logger.info("Found password input, waiting 1 second");
				await this.page.waitForTimeout(1000);
				logger.trace("Wait complete, entering password");
				await this.page.type(
					"input#password.mCAa0e",
					process.env.PASSWORD || ""
				);
				await this.page.click("input#submit.MK9CEd.MVpUfe");
				logger.info("Password entered and clicked login button");

				let attempts = 0;
				while (
					this.page.url() !== `${process.env.BASE_URL}/app/student` ||
					attempts >= 30
				) {
					attempts++;
					await this.page.waitForTimeout(1000);
				}

				if (attempts >= 30) {
					reject("login failed");
				}

				// google login success
				const cookies = await this.page.cookies();
				const t = cookies.find((c) => c.name === "t");
				if (!t) {
					reject("Cookie not found");
					return;
				}

				logger.info("token cookie found");
				logger.trace(t);
				resolve(t.value);
			} catch (err) {
				reject(err);
			}
		});
	}
}

fs.mkdir("./public/errors", { recursive: true }).catch();

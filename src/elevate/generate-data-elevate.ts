import { DataGenerator, PodContext } from "../data-generator";
import {
  Activity,
  ActivityFileType, ActivityFlag, ActivityStats, AthleteSettings, AthleteSnapshot,
  ConnectorType,
  ElevateSport, Gender,
  Peak,
  SlopeProfile,
  SlopeStats,
  ZoneModel
} from "./utils/elevate-types";
import * as fs from 'fs';
import * as path from 'path';
import {ActivityRDFWrite} from "./utils/activityRDFWrite";

export type ActivityGeneratorOptions = {
  activity_type: ElevateSport,
  with_power_meter: boolean,
  with_heart_rate_meter: boolean,
  with_cadence_meter: boolean,
  with_flags: boolean,
  with_dynamics: boolean,
  with_laps: boolean,
  with_source_stats: boolean,
  bare_minimum: boolean
};

export const ComplexityMap: Record<string, ActivityGeneratorOptions> = {
  "minimal": {
    activity_type: ElevateSport.Swim,
    with_cadence_meter: false,
    with_dynamics: false,
    with_flags: false,
    with_heart_rate_meter: false,
    with_laps: false,
    with_power_meter: false,
    with_source_stats: false,
    bare_minimum: true
  },
  "simple": {
    activity_type: ElevateSport.Run,
    with_cadence_meter: false,
    with_dynamics: false,
    with_flags: false,
    with_heart_rate_meter: false,
    with_laps: false,
    with_power_meter: false,
    with_source_stats: false,
    bare_minimum: false
  },
  "complex": {
    activity_type: ElevateSport.Ride,
    with_cadence_meter: true,
    with_dynamics: true,
    with_flags: true,
    with_heart_rate_meter: true,
    with_laps: true,
    with_power_meter: true,
    with_source_stats: true,
    bare_minimum: false
  }
}

export class ElevateDataGenerator extends DataGenerator {

  private getExperimentPrefix(experimentId: string) {
    return `${experimentId}`;
  }

  protected getPodName(user: string, experimentId: string): string {
    return `${this.getExperimentPrefix(experimentId)}_${user}`;
  }

  protected getUserPodContext(user: string, experimentId: string): PodContext {
    return this.getOrCreatePodContext(this.getPodName(user, experimentId));
  }

  protected getUserPodRelativePath(user: string, experimentId: string) {
    return this.getUserPodContext(user, experimentId).relativePath;
  }

  protected getUserPodUrl(user: string, experimentId: string) {
    return this.getUserPodContext(user, experimentId).baseUrl;
  }

  protected getUserIssuerUrl(user: string, experimentId: string) {
    return this.getUserPodContext(user, experimentId).server.solidBaseUrl;
  }

  // Lightweight randomization helpers
  private jitter(value: number, percent: number = 0.15): number {
    const factor = 1 + (Math.random() * 2 - 1) * percent; // +-percent
    return Number((value * factor).toFixed(2));
  }
  private randInt(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min + 1));
  }
  private randFloat(min: number, max: number, digits = 2): number {
    return Number((min + Math.random() * (max - min)).toFixed(digits));
  }

  private randDateInLastYear(): Date {
    // Generate random date in 2025 (between Jan 1, 2025 and Dec 31, 2025)
    const startOf2025 = new Date('2025-01-01T00:00:00.000Z').getTime();
    const endOf2025 = new Date('2025-12-31T23:59:59.999Z').getTime();
    const randomTime = startOf2025 + Math.random() * (endOf2025 - startOf2025);
    return new Date(randomTime);
  }

  generateActivity(podContext: PodContext, activityId: string, options: ActivityGeneratorOptions): string {
    const act = new Activity();

    // Determine if activity is ride, run, or swim
    const isRide = Activity.isRide(options.activity_type);
    const isRun = Activity.isRun(options.activity_type);
    const isSwim = options.activity_type === ElevateSport.Swim;

    act.id = `${podContext.baseUrl}/activities/${activityId}#activity`;
    act.name = this.getActivityName(options.activity_type);
    act.type = options.activity_type;

    // Generate random start time in the last year
    const startDate = this.randDateInLastYear();
    act.startTime = startDate.toISOString();
    act.startTimestamp = Math.floor(startDate.getTime() / 1000);

    // End time is 2.5 hours after start time
    const endDate = new Date(startDate.getTime() + 2.5 * 60 * 60 * 1000);
    act.endTime = endDate.toISOString();
    act.endTimestamp = Math.floor(endDate.getTime() / 1000);

    act.hasPowerMeter = options.with_power_meter;
    act.trainer = false;
    act.settingsLack = false;
    act.hash = `activity-hash-${Date.now()}`;

    // Creation time is 5 minutes after end time
    const creationDate = new Date(endDate.getTime() + 5 * 60 * 1000);
    act.creationTime = creationDate.toISOString();

    if (options.bare_minimum) {
      act.stats = {} as ActivityStats;

      const athleteSettings = new AthleteSettings(
        190,
        65,
        // @ts-ignore
        undefined,
        undefined,
        undefined,
        undefined,
        this.randInt(60, 85)
      );

      // @ts-ignore
      act.athleteSnapshot = new AthleteSnapshot(Gender.MEN, undefined, athleteSettings);

      const activitiesDir = path.join(podContext.absolutePath, 'activities');
      fs.mkdirSync(activitiesDir, { recursive: true });

      const activityLocation = `${podContext.baseUrl}/activities/${activityId}`;
      let activityRDFWrite = new ActivityRDFWrite();
      const ttl = activityRDFWrite.write(activityLocation, act);

      const filePath = path.join(activitiesDir, `${activityId}$.ttl`);
      fs.writeFileSync(filePath, ttl);

      return activityLocation;
    }

    act.commute = Math.random() > 0.5;
    act.manual = false;

    act.isSwimPool = isSwim ? Math.random() > 0.5 : undefined;
    act.connector = ConnectorType.SOLID;
    act.latLngCenter = [this.randFloat(50.83, 50.95), this.randFloat(4.30, 4.45)];
    act.lastEditTime = act.creationTime;
    act.device = this.getDeviceName(options.activity_type);
    act.notes = "Training session";
    act.autoDetectedType = false;

    // Flags: add 1-3 flags if enabled
    if (options.with_flags) {
      const flagCount = this.randInt(1, 3);
      const availableFlags = this.getAvailableFlags(options);
      act.flags = this.selectRandomFlags(availableFlags, flagCount);
    } else {
      act.flags = [];
    }

    // Athlete snapshot with complete settings
    const athleteSettings = new AthleteSettings(
      190,
      65,
      { default: 170, cycling: 180, running: 175 },
      isRide ? this.randInt(230, 280) : null,
      isRun ? this.randInt(280, 330) : null,
      isSwim ? this.randInt(130, 170) : null,
      this.randInt(60, 85)
    );
    act.athleteSnapshot = new AthleteSnapshot(Gender.MEN, this.randInt(20, 55), athleteSettings);

    // Zones (add slight jitter to time/percent)
    const jitterZone = (z: ZoneModel) => ({
      from: z.from,
      to: z.to,
      s: this.randInt(Math.max(1, Math.floor((z.s ?? 0) * 0.85)), Math.floor((z.s ?? 0) * 1.15)),
      percent: this.randFloat(Math.max(0.5, (z.percent ?? 0) * 0.8), (z.percent ?? 0) * 1.2, 1)
    } as ZoneModel);

    const speedZones = [
      jitterZone({ from: 0, to: 20, s: 1800, percent: 20 }),
      jitterZone({ from: 20, to: 25, s: 2700, percent: 30 }),
      jitterZone({ from: 25, to: 30, s: 1800, percent: 20 }),
      jitterZone({ from: 30, to: 35, s: 1350, percent: 15 }),
      jitterZone({ from: 35, to: null, s: 1350, percent: 15 })
    ];

    const powerZones = [
      jitterZone({ from: 0, to: 125, s: 1800, percent: 20 }),
      jitterZone({ from: 125, to: 175, s: 2700, percent: 30 }),
      jitterZone({ from: 175, to: 200, s: 1800, percent: 20 }),
      jitterZone({ from: 200, to: 225, s: 1350, percent: 15 }),
      jitterZone({ from: 225, to: null, s: 1350, percent: 15 })
    ];

    const hrZones = [
      jitterZone({ from: 65, to: 120, s: 900, percent: 10 }),
      jitterZone({ from: 120, to: 140, s: 1800, percent: 20 }),
      jitterZone({ from: 140, to: 160, s: 2700, percent: 30 }),
      jitterZone({ from: 160, to: 175, s: 2250, percent: 25 }),
      jitterZone({ from: 175, to: null, s: 1350, percent: 15 })
    ];

    const cadenceZones = [
      jitterZone({ from: 0, to: 70, s: 450, percent: 5 }),
      jitterZone({ from: 70, to: 85, s: 2250, percent: 25 }),
      jitterZone({ from: 85, to: 95, s: 3600, percent: 40 }),
      jitterZone({ from: 95, to: 105, s: 2250, percent: 25 }),
      jitterZone({ from: 105, to: null, s: 450, percent: 5 })
    ];

    const gradeZones = [
      jitterZone({ from: -10, to: -2, s: 900, percent: 10 }),
      jitterZone({ from: -2, to: 2, s: 5400, percent: 60 }),
      jitterZone({ from: 2, to: 6, s: 1800, percent: 20 }),
      jitterZone({ from: 6, to: null, s: 900, percent: 10 })
    ];

    const elevationZones = [
      jitterZone({ from: 100, to: 150, s: 1800, percent: 20 }),
      jitterZone({ from: 150, to: 200, s: 2700, percent: 30 }),
      jitterZone({ from: 200, to: 250, s: 2250, percent: 25 }),
      jitterZone({ from: 250, to: 300, s: 1350, percent: 15 }),
      jitterZone({ from: 300, to: null, s: 900, percent: 10 })
    ];

    // Peaks with jitter
    const jitterPeak = (p: Peak, percent = 0.1): Peak => ({
      range: p.range,
      result: this.jitter(p.result, percent),
      start: this.randInt(Math.max(0, Math.floor(p.start * 0.9)), Math.floor(p.start * 1.1)),
      end: this.randInt(Math.max(p.end - Math.floor(p.range * 1.1), Math.floor(p.end * 0.9)), Math.floor(p.end * 1.1))
    });

    const speedPeaks: Peak[] = [
      jitterPeak({ range: 5, result: 52.3, start: 1200, end: 1205 }),
      jitterPeak({ range: 20, result: 47.8, start: 3600, end: 3620 }),
      jitterPeak({ range: 60, result: 42.1, start: 5400, end: 5460 }),
      jitterPeak({ range: 300, result: 38.5, start: 2700, end: 3000 }),
      jitterPeak({ range: 1200, result: 11.67, start: 1800, end: 3000 })
    ];

    const powerPeaks: Peak[] = [
      jitterPeak({ range: 5, result: 890, start: 1200, end: 1205 }),
      jitterPeak({ range: 20, result: 420, start: 3600, end: 3620 }),
      jitterPeak({ range: 60, result: 380, start: 5400, end: 5460 }),
      jitterPeak({ range: 300, result: 310, start: 2700, end: 3000 }),
      jitterPeak({ range: 1200, result: 340, start: 1800, end: 3000 })
    ];

    const hrPeaks: Peak[] = [
      jitterPeak({ range: 20, result: 185, start: 1200, end: 1220 }),
      jitterPeak({ range: 60, result: 178, start: 3600, end: 3660 }),
      jitterPeak({ range: 300, result: 165, start: 5400, end: 5700 }),
      jitterPeak({ range: 1200, result: 150, start: 2700, end: 3900 }),
      jitterPeak({ range: 3600, result: 140, start: 0, end: 3600 })
    ];

    const cadencePeaks: Peak[] = [
      jitterPeak({ range: 20, result: 115, start: 1200, end: 1220 }),
      jitterPeak({ range: 60, result: 108, start: 3600, end: 3660 }),
      jitterPeak({ range: 300, result: 95, start: 5400, end: 5700 })
    ];

    // Slope stats with slight jitter
    const slopeStats: SlopeStats = {
      up: this.randInt(2400, 3000),
      flat: this.randInt(5000, 5800),
      down: this.randInt(800, 1100),
      total: 9000
    };

    // Complete activity stats with sensible jitter
    act.stats = {
      distance: this.randInt(2000, 100000),
      elevationGain: this.randInt(0, 2000),
      elapsedTime: 9000,
      movingTime: this.randInt(7000, 9000),
      pauseTime: this.randInt(0, 1000),
      moveRatio: this.randFloat(0.7, 1.0, 3),
      calories: this.randInt(200, 4000),
      caloriesPerHour: this.randInt(300, 1200),

      scores: {
        stress: {
          hrss: options.with_heart_rate_meter ? this.randInt(60, 180) : 0,
          hrssPerHour: options.with_heart_rate_meter ? this.randFloat(20, 80) : 0,
          trimp: options.with_heart_rate_meter ? this.randInt(50, 250) : 0,
          trimpPerHour: options.with_heart_rate_meter ? this.randFloat(20, 90) : 0,
          rss: isRun ? this.randInt(50, 200) : 0,
          rssPerHour: isRun ? this.randFloat(20, 90) : 0,
          sss: isSwim ? this.randInt(50, 200) : 0,
          sssPerHour: isSwim ? this.randFloat(20, 90) : 0,
          pss: options.with_power_meter ? this.randInt(50, 250) : 0,
          pssPerHour: options.with_power_meter ? this.randFloat(20, 90) : 0,
          trainingEffect: {
            aerobic: this.randFloat(1.0, 5.0),
            anaerobic: this.randFloat(1.0, 5.0)
          }
        },
        efficiency: options.with_power_meter ? this.randFloat(70, 100) : undefined,
        powerHr: options.with_power_meter && options.with_heart_rate_meter ? this.randFloat(1.2, 2.2) : undefined,
        runningRating: isRun ? this.randInt(10, 50) : undefined,
        swolf: isSwim ? { "25": this.randInt(10, 35), "50": this.randInt(20, 70) } : undefined
      },

      speed: {
        avg: this.randFloat(2, 12),
        max: this.randFloat(5, 20),
        best20min: this.randFloat(4, 15),
        lowQ: this.randFloat(2, 8),
        median: this.randFloat(3, 10),
        upperQ: this.randFloat(5, 12),
        stdDev: this.randFloat(0.5, 4),
        zones: speedZones,
        peaks: speedPeaks
      },

      pace: {
        avg: this.randInt(90, 180),
        gapAvg: this.randInt(90, 200),
        max: this.randInt(50, 120),
        best20min: this.randInt(80, 160),
        lowQ: this.randInt(90, 220),
        median: this.randInt(80, 200),
        upperQ: this.randInt(70, 180),
        stdDev: this.randInt(5, 30),
        zones: []
      },

      ...(options.with_power_meter && {
        power: {
          avg: this.randInt(150, 350),
          avgKg: this.randFloat(2.0, 5.5),
          weighted: this.randInt(170, 380),
          weightedKg: this.randFloat(2.2, 6.0),
          max: this.randInt(600, 1200),
          work: this.randInt(1000000, 3000000),
          best20min: this.randInt(180, 380),
          variabilityIndex: this.randFloat(1.0, 1.3),
          intensityFactor: this.randFloat(0.6, 1.1),
          lowQ: this.randInt(120, 260),
          median: this.randInt(150, 300),
          upperQ: this.randInt(200, 360),
          stdDev: this.randInt(30, 120),
          zones: powerZones,
          peaks: powerPeaks
        }
      }),

      ...(options.with_heart_rate_meter && {
        heartRate: {
          avg: this.randInt(110, 175),
          max: this.randInt(160, 195),
          avgReserve: this.randFloat(40, 85),
          maxReserve: this.randFloat(80, 98),
          best20min: this.randInt(120, 180),
          best60min: this.randInt(110, 170),
          lowQ: this.randInt(90, 160),
          median: this.randInt(100, 170),
          upperQ: this.randInt(120, 180),
          stdDev: this.randInt(5, 20),
          zones: hrZones,
          peaks: hrPeaks
        }
      }),

      ...(options.with_cadence_meter && {
        cadence: {
          avg: this.randInt(70, 100),
          max: this.randInt(90, 130),
          avgActive: this.randInt(75, 105),
          activeRatio: this.randFloat(0.7, 1.0, 3),
          activeTime: this.randInt(7000, 9000),
          cycles: this.randInt(10000, 15000),
          distPerCycle: this.randFloat(3.5, 6.5),
          lowQ: this.randInt(60, 90),
          median: this.randInt(70, 100),
          upperQ: this.randInt(80, 110),
          slope: slopeStats,
          stdDev: this.randInt(5, 15),
          zones: cadenceZones,
          peaks: cadencePeaks
        }
      }),

      grade: {
        avg: this.randFloat(-2, 3),
        max: this.randFloat(8, 20),
        min: this.randFloat(-12, -1),
        lowQ: this.randFloat(-4, 0),
        median: this.randFloat(-1, 2),
        upperQ: this.randFloat(1, 5),
        stdDev: this.randFloat(1, 6),
        slopeTime: slopeStats,
        slopeSpeed: slopeStats,
        slopePace: slopeStats,
        slopeDistance: slopeStats,
        slopeCadence: slopeStats,
        slopeProfile: SlopeProfile.HILLY,
        zones: gradeZones
      },

      elevation: {
        avg: this.randInt(50, 300),
        max: this.randInt(150, 800),
        min: this.randInt(0, 120),
        ascent: this.randInt(0, 2000),
        descent: this.randInt(0, 2000),
        ascentSpeed: this.randFloat(0.5, 2.5),
        lowQ: this.randInt(30, 200),
        median: this.randInt(50, 250),
        upperQ: this.randInt(80, 300),
        stdDev: this.randInt(20, 100),
        elevationZones: elevationZones
      },

      ...(options.with_dynamics && {
        dynamics: {
          ...(isRide && {
            cycling: {
              standingTime: this.randInt(200, 1200),
              seatedTime: this.randInt(6000, 8200),
              balance: { left: this.randFloat(45, 52), right: this.randFloat(48, 55) },
              pedalSmoothness: { left: this.randFloat(15, 35), right: this.randFloat(15, 35) },
              torqueEffectiveness: { left: this.randFloat(70, 95), right: this.randFloat(70, 95) }
            }
          }),
          ...(isRun && {
            running: {
              stanceTimeBalance: { left: this.randFloat(48, 52), right: this.randFloat(48, 52) },
              stanceTime: this.randInt(800, 1800),
              verticalOscillation: this.randFloat(6, 12),
              verticalRatio: this.randFloat(15, 25),
              avgStrideLength: this.randFloat(0.9, 1.5)
            }
          })
        }
      })
    } as ActivityStats;

    // Complete laps - add between 1 and 10 laps if enabled
    if (options.with_laps) {
      const lapCount = this.randInt(1, 10);
      act.laps = this.generateLaps(lapCount, act.stats.movingTime, act.stats.distance, options);
    } else {
      act.laps = [];
    }

    // Source stats, this is data that comes from the device or source file directly
    if (options.with_source_stats) {
      act.srcStats = {
        distance: act.stats.distance,
        elevationGain: act.stats.elevationGain,
        elapsedTime: act.stats.elapsedTime,
        movingTime: act.stats.movingTime,
        pauseTime: act.stats.pauseTime,
        moveRatio: act.stats.moveRatio,
        calories: act.stats.calories,
        caloriesPerHour: act.stats.caloriesPerHour,

        scores: {
          stress: {
            hrss: options.with_heart_rate_meter ? act.stats.scores.stress.hrss : 0,
            hrssPerHour: options.with_heart_rate_meter ? act.stats.scores.stress.hrssPerHour : 0,
            trimp: options.with_heart_rate_meter ? act.stats.scores.stress.trimp : 0,
            trimpPerHour: options.with_heart_rate_meter ? act.stats.scores.stress.trimpPerHour : 0,
            rss: isRun ? act.stats.scores.stress.rss : 0,
            rssPerHour: isRun ? act.stats.scores.stress.rssPerHour : 0,
            sss: isSwim ? act.stats.scores.stress.sss : 0,
            sssPerHour: isSwim ? act.stats.scores.stress.sssPerHour : 0,
            pss: options.with_power_meter ? act.stats.scores.stress.pss : 0,
            pssPerHour: options.with_power_meter ? act.stats.scores.stress.pssPerHour : 0,
            trainingEffect: act.stats.scores.stress.trainingEffect
          },
          efficiency: options.with_power_meter ? act.stats.scores.efficiency : undefined,
          powerHr: options.with_power_meter && options.with_heart_rate_meter ? act.stats.scores.powerHr : undefined,
          runningRating: isRun ? act.stats.scores.runningRating : undefined,
          swolf: isSwim ? act.stats.scores.swolf : undefined
        },

        speed: act.stats.speed,
        pace: act.stats.pace,

        ...(options.with_power_meter && act.stats.power && {
          power: act.stats.power
        }),

        ...(options.with_heart_rate_meter && {
          heartRate: act.stats.heartRate
        }),

        ...(options.with_cadence_meter && {
          cadence: act.stats.cadence
        }),

        grade: act.stats.grade,
        elevation: act.stats.elevation,

        ...(options.with_dynamics && act.stats.dynamics && {
          dynamics: act.stats.dynamics
        })
      };
    }

    // Extras
    act.extras = {
      file: {
        path: `${podContext.baseUrl}/uploads/activities/activity_${this.randInt(100000000, 999999999)}.fit`,
        type: ActivityFileType.FIT
      }
    };

    // Write the activity to disk
    const activitiesDir = path.join(podContext.absolutePath, 'activities');
    fs.mkdirSync(activitiesDir, { recursive: true });

    const activityLocation = `${podContext.baseUrl}/activities/${activityId}`;
    let activityRDFWrite = new ActivityRDFWrite();
    const ttl = activityRDFWrite.write(activityLocation, act);

    const filePath = path.join(activitiesDir, `${activityId}$.ttl`);
    fs.writeFileSync(filePath, ttl);

    return activityLocation;
  }

  private getActivityName(activityType: ElevateSport): string {
    const names = {
      [ElevateSport.Ride]: ["Morning Cycling Training", "Afternoon Ride", "Evening Bike Session", "Hill Climb Training"],
      [ElevateSport.VirtualRide]: ["Zwift Session", "Indoor Cycling Workout", "Virtual Training Ride"],
      [ElevateSport.EBikeRide]: ["E-Bike Commute", "Electric Bike Ride", "Assisted Cycling"],
      [ElevateSport.Run]: ["Morning Run", "Interval Training", "Long Run", "Speed Work"],
      [ElevateSport.VirtualRun]: ["Treadmill Session", "Indoor Run", "Virtual Running Workout"],
      [ElevateSport.Swim]: ["Pool Swimming", "Open Water Swim", "Swim Training"],
      [ElevateSport.Hike]: ["Mountain Hike", "Trail Hiking", "Nature Walk"],
      [ElevateSport.Walk]: ["Morning Walk", "Evening Stroll", "Recovery Walk"]
    };

    const options = names[activityType] || ["Training Session"];
    return options[Math.floor(Math.random() * options.length)];
  }

  private getDeviceName(activityType: ElevateSport): string {
    const devices = {
      [ElevateSport.Ride]: ["Garmin Edge 530", "Garmin Edge 830", "Wahoo ELEMNT BOLT", "Garmin Edge 1030"],
      [ElevateSport.VirtualRide]: ["Garmin Edge 530", "Wahoo KICKR", "Zwift Hub"],
      [ElevateSport.EBikeRide]: ["Garmin Edge 530", "Garmin Edge 830"],
      [ElevateSport.Run]: ["Garmin Forerunner 945", "Garmin Forerunner 255", "Polar Vantage V2", "Coros Pace 2"],
      [ElevateSport.VirtualRun]: ["Garmin Forerunner 945", "Zwift Running Pod"],
      [ElevateSport.Swim]: ["Garmin Swim 2", "Garmin Forerunner 945", "Apple Watch Ultra"],
      [ElevateSport.Hike]: ["Garmin Fenix 7", "Garmin Instinct 2", "Suunto 9"],
      [ElevateSport.Walk]: ["Garmin Forerunner 55", "Apple Watch", "Fitbit Charge"]
    };

    const options = devices[activityType] || ["Garmin Device"];
    return options[Math.floor(Math.random() * options.length)];
  }

  private getAvailableFlags(options: ActivityGeneratorOptions): ActivityFlag[] {
    const flags: ActivityFlag[] = [
      ActivityFlag.MOVING_TIME_GREATER_THAN_ELAPSED,
      ActivityFlag.SPEED_AVG_ABNORMAL,
      ActivityFlag.SPEED_STD_DEV_ABNORMAL,
      ActivityFlag.ASCENT_SPEED_ABNORMAL,
      ActivityFlag.PACE_AVG_FASTER_THAN_GAP,
      ActivityFlag.HR_AVG_ABNORMAL,
      ActivityFlag.SCORE_HRSS_PER_HOUR_ABNORMAL
    ];

    if (options.with_power_meter) {
      flags.push(
        ActivityFlag.POWER_AVG_KG_ABNORMAL,
        ActivityFlag.POWER_THRESHOLD_ABNORMAL,
        ActivityFlag.SCORE_PSS_PER_HOUR_ABNORMAL
      );
    }

    const isRun = Activity.isRun(options.activity_type);
    const isSwim = options.activity_type === ElevateSport.Swim;

    if (isRun) {
      flags.push(ActivityFlag.SCORE_RSS_PER_HOUR_ABNORMAL);
    }

    if (isSwim) {
      flags.push(ActivityFlag.SCORE_SSS_PER_HOUR_ABNORMAL);
    }

    return flags;
  }

  private selectRandomFlags(availableFlags: ActivityFlag[], count: number): ActivityFlag[] {
    const shuffled = [...availableFlags].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, availableFlags.length));
  }

  private generateLaps(count: number, totalMovingTime: number, totalDistance: number, options: ActivityGeneratorOptions): any[] {
    const laps: any[] = [];
    const isRide = Activity.isRide(options.activity_type);
    const isRun = Activity.isRun(options.activity_type);
    const isSwim = options.activity_type === ElevateSport.Swim;

    let currentTime = 0;
    const avgLapTime = totalMovingTime / count;
    const avgLapDistance = totalDistance / count;

    for (let i = 0; i < count; i++) {
      const lapTime = avgLapTime * (0.8 + Math.random() * 0.4);
      const lapDistance = avgLapDistance * (0.75 + Math.random() * 0.5);
      const startTime = currentTime;
      const endTime = currentTime + lapTime;

      const lap: any = {
        id: i + 1,
        active: true,
        indexes: [Math.floor(startTime), Math.floor(endTime)],
        distance: Math.floor(lapDistance),
        elevationGain: this.randInt(20, 300),
        elapsedTime: Math.floor(lapTime),
        movingTime: Math.floor(lapTime * (0.93 + Math.random() * 0.07)),
        avgSpeed: Number((lapDistance / lapTime).toFixed(3)),
        maxSpeed: Number(((lapDistance / lapTime) * (1.15 + Math.random() * 0.25)).toFixed(3)),
        avgPace: Math.floor((lapTime / (lapDistance / 1000)) / 60),
        maxPace: Number((Math.floor((lapTime / (lapDistance / 1000)) / 60) * (0.65 + Math.random() * 0.2)).toFixed(2)),
        calories: this.randInt(Math.floor(lapTime * 0.1), Math.floor(lapTime * 0.2))
      };

      if (options.with_heart_rate_meter) {
        lap.avgHr = this.randInt(120, 175);
        lap.maxHr = lap.avgHr + this.randInt(5, 20);
      }

      if (options.with_cadence_meter) {
        lap.avgCadence = this.randInt(70, 105);
      }

      if (options.with_power_meter && isRide) {
        lap.avgWatts = this.randInt(180, 340);
      }

      if (isSwim) {
        lap.swolf25m = this.randInt(12, 40);
        lap.swolf50m = this.randInt(25, 80);
      }

      laps.push(lap);
      currentTime = endTime;
    }

    return laps;
  }
}

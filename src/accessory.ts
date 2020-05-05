import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  Logging,
  Service
} from "homebridge";

import { ThermostatdClient, State } from "thermostatd";

let hap: HAP;

const fToC = (f: number): number => (f - 32) / 1.8;
const cToF = (c: number): number => c * 1.8 + 32;

const getClosestEven = (num: number): number => {
  const rnd = Math.round(num);
  return (rnd % 2 !== 0) ? rnd + 1 : rnd;
}

const clamp = (num: number, min: number, max: number): number => Math.min(Math.max(num, min), max);

class ThermostatdAccessory implements AccessoryPlugin {
  private readonly log: Logging;

  private readonly thermostatdClient: ThermostatdClient;
  private state: State;

  private readonly thermostatService: Service;
  private readonly fanService: Service;
  private readonly informationService: Service;

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;

    // Default state
    this.state = config.defaultState || {
      powered_on: false,
      current_mode: "COOL",
      fan_speed: "AUTO",
      target_temperature: 72,
      current_temperature: 0
    };

    this.thermostatdClient = new ThermostatdClient(config.host, config.token);
    this.thermostatdClient.patchState(this.state);

    this.fanService = new hap.Service.Fan("Fan");

    this.fanService.getCharacteristic(hap.Characteristic.On)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        // fan is always "on"
        callback(null, true);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        if(value === false) {
          this.state.fan_speed = "AUTO";
          this.updateState();
        }

        callback();
      })

    this.fanService.getCharacteristic(hap.Characteristic.RotationSpeed)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(
          null,
          {
            "AUTO": 0,
            "QUIET": 25,
            "LOW": 50,
            "MEDIUM": 75,
            "HIGH": 100
          }[this.state.fan_speed]
        );
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        if(value === 0) {
          this.state.fan_speed = "AUTO";
          this.updateState();
          callback();
          return;
        }

        const ranges = [
          [
            [1, 25], "QUIET"
          ],
          [
            [26, 50], "LOW"
          ],
          [
            [51, 75], "MEDIUM"
          ],
          [
            [76, 100], "HIGH"
          ]
        ];

        const speed = ranges.find(r => <number>value >= r[0][0] && <number>value <= r[0][1])![1];
        this.state.fan_speed = <"QUIET" | "LOW" | "MEDIUM" | "HIGH">speed;
        this.updateState();
        callback();
      });

    this.thermostatService = new hap.Service.Thermostat("Temperature Control");
    this.thermostatService.setCharacteristic(hap.Characteristic.TemperatureDisplayUnits, 1); // F

    this.thermostatService.getCharacteristic(hap.Characteristic.On)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, this.state.powered_on);
      });

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        if(this.state.powered_on === false) {
          callback(null, hap.Characteristic.TargetHeatingCoolingState.OFF);
          return;
        }

        callback(
          null,
          {
            "HEAT": hap.Characteristic.TargetHeatingCoolingState.HEAT,
            "COOL": hap.Characteristic.TargetHeatingCoolingState.COOL,
            "DRY": hap.Characteristic.TargetHeatingCoolingState.AUTO,
            "FAN": hap.Characteristic.TargetHeatingCoolingState.AUTO
          }[this.state.current_mode]
        );
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        let target: any = { };
        if(value === hap.Characteristic.TargetHeatingCoolingState.OFF) {
          target.powered_on = false;
        } else {
          target.powered_on = true;
          switch(value) {
            case hap.Characteristic.TargetHeatingCoolingState.HEAT:
              target.current_mode = "HEAT";
              break;
            case hap.Characteristic.TargetHeatingCoolingState.COOL:
              target.current_mode = "COOL";
              break;
            case hap.Characteristic.TargetHeatingCoolingState.AUTO:
              target.current_mode = "FAN";
              break;
          }
        }

        // fire async, don't really care about return value
        // FIXME this is ugly ugly ugly, probably want some universal state change checking thing
        if(target.powered_on !== this.state.powered_on || target.current_mode !== this.state.current_mode) {
          this.state.powered_on = target.powered_on;
          this.state.current_mode = target.current_mode;
          this.updateState();
        }

        callback();
      });

    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, fToC(this.state.target_temperature));
      });
    
    this.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, fToC(this.state.target_temperature));
      })
      .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        let floor, ceil
        if(this.state.current_mode === "HEAT")
          [ floor, ceil ] = [ 60, 76 ];
        else
          [ floor, ceil ] = [ 64, 88 ];

        const target = getClosestEven(clamp(cToF(<number>value), floor, ceil));
        if(target === this.state.target_temperature) return;
        this.state.target_temperature = target;
        await this.updateState();
        
        this.thermostatService.setCharacteristic(hap.Characteristic.CurrentTemperature, fToC(this.state.target_temperature));
        callback(null, fToC(this.state.target_temperature));
      });

    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, "thermostatd")
      .setCharacteristic(hap.Characteristic.Model, "thermostatd")
      .setCharacteristic(hap.Characteristic.Name, config.name)
      .setCharacteristic(hap.Characteristic.SerialNumber, config.host);
  }

  async updateState(): Promise<State> {
    try {
      const newState = await this.thermostatdClient.patchState(this.state);
      this.state = newState;
    } catch(e) {
      console.log(e);
    }
    return this.state;
  }

  getServices(): Service[] {
    return [
      this.informationService,
      this.thermostatService,
      this.fanService
    ];
  }
}

export = (api: API) => {
  hap = api.hap;
  api.registerAccessory("ThermostatdAccessory", ThermostatdAccessory);
};
# homebridge-thermostatd-accessory

Homebridge accessory for thermostatd.

## Example config

```js
{
  // ...
  "accessories": [
    {
      "accessory": "ThermostatdAccessory",
      "name": "Thermostat",
      "host": "http://127.0.0.1:8080",
      "token": "cool_token_goes_here"
    }
  ],
  // ...
}
```
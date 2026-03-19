import ExcelJS from 'exceljs'
import Chart from 'chart.js/auto'
import { toZonedTime } from 'date-fns-tz'
import { format } from 'date-fns'
import type { HistoryRow } from '../types'

const TZ = 'America/Los_Angeles'

function epochToLabel(epoch: number): string {
  const zoned = toZonedTime(new Date(epoch * 1000), TZ)
  return format(zoned, 'MMM d yyyy, h:mm a')
}

function buildRawDataSheet(ws: ExcelJS.Worksheet, rows: HistoryRow[]): void {
  ws.columns = [
    { header: 'Timestamp (LA Time)', key: 'ts',       width: 24 },
    { header: 'Temp (°C)',           key: 'temp',     width: 12 },
    { header: 'Pressure (hPa)',      key: 'pressure', width: 14 },
    { header: 'Humidity (%)',        key: 'humidity', width: 14 },
    { header: 'Soil Raw (0–4095)',   key: 'soil',     width: 16 },
    { header: 'Light',               key: 'light',    width: 10 },
    { header: 'Pump',                key: 'pump',     width: 10 },
    { header: 'Notes',               key: 'notes',    width: 20 },
  ]

  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  rows.forEach((row, i) => {
    const dataRow = ws.addRow({
      ts:       epochToLabel(row.epoch),
      temp:     isNaN(row.t) ? '' : Math.round(row.t * 10) / 10,
      pressure: Math.round(row.p / 100 * 10) / 10,
      humidity: row.h == null || isNaN(row.h) ? '' : Math.round(row.h * 10) / 10,
      soil:     row.s,
      light:    row.l === 1 ? 'Bright' : 'Dim',
      pump:     row.pu === 1 ? 'ON' : 'OFF',
      notes:    '',
    })

    if (i % 2 === 0) {
      dataRow.eachCell(cell => {
        cell.fill = {
          type: 'pattern', pattern: 'solid',
          fgColor: { argb: 'FFF5F5F5' },
        }
      })
    }
  })
}

async function renderChartToPng(
  labels: string[],
  data: (number | string)[],
  title: string,
  yLabel: string,
  stepped: boolean
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = 900
  canvas.height = 350
  document.body.appendChild(canvas)

  let chart: Chart | null = null
  try {
    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: title,
          data: data as number[],
          borderColor: '#3B7A57',
          backgroundColor: 'rgba(59,122,87,0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          stepped: stepped ? true : false,
          tension: stepped ? 0 : 0.3,
        }],
      },
      options: {
        animation: false,
        responsive: false,
        plugins: {
          title:  { display: true, text: title, font: { size: 14 } },
          legend: { display: false },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 12, maxRotation: 30 } },
          y: { title: { display: true, text: yLabel } },
        },
      },
    })
    return canvas.toDataURL('image/png')
  } finally {
    chart?.destroy()
    document.body.removeChild(canvas)
  }
}

async function buildChartsSheet(ws: ExcelJS.Worksheet, workbook: ExcelJS.Workbook, rows: HistoryRow[]): Promise<void> {
  ws.getCell('A1').value = 'Charts (generated from export data)'
  ws.getCell('A1').font = { bold: true, size: 13 }

  const labels    = rows.map(r => epochToLabel(r.epoch))
  const tempData  = rows.map(r => isNaN(r.t) ? 0 : Math.round(r.t * 10) / 10)
  const humData   = rows.map(r => r.h == null ? 0 : Math.round(r.h * 10) / 10)
  const soilData  = rows.map(r => r.s)
  const presData  = rows.map(r => Math.round(r.p / 100 * 10) / 10)
  const lightData = rows.map(r => r.l)
  const pumpData  = rows.map(r => r.pu)

  const charts: Array<{ data: number[], title: string, yLabel: string, stepped: boolean }> = [
    { data: tempData,  title: 'Temperature over Time',   yLabel: '°C',              stepped: false },
    { data: humData,   title: 'Humidity over Time',      yLabel: '%',               stepped: false },
    { data: soilData,  title: 'Soil Moisture over Time', yLabel: 'ADC (0–4095)',    stepped: false },
    { data: presData,  title: 'Pressure over Time',      yLabel: 'hPa',             stepped: false },
    { data: lightData, title: 'Light Level over Time',   yLabel: '1=Bright, 0=Dim', stepped: true  },
    { data: pumpData,  title: 'Pump Activity over Time', yLabel: '1=ON, 0=OFF',     stepped: true  },
  ]

  let rowOffset = 2
  for (const c of charts) {
    const png = await renderChartToPng(labels, c.data, c.title, c.yLabel, c.stepped)
    const imageId = workbook.addImage({ base64: png.split(',')[1], extension: 'png' })
    ws.addImage(imageId, {
      tl: { col: 0, row: rowOffset },
      ext: { width: 900, height: 350 },
    })
    rowOffset += 20
  }
}

export async function exportToExcel(
  rows: HistoryRow[],
  startDate: Date,
  endDate: Date
): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'SmartPlantPro'
  workbook.created = new Date()

  const rawSheet = workbook.addWorksheet('Raw Data')
  buildRawDataSheet(rawSheet, rows)

  const chartsSheet = workbook.addWorksheet('Charts')
  await buildChartsSheet(chartsSheet, workbook, rows)

  const fmt = (d: Date) => format(toZonedTime(d, TZ), 'yyyy-MM-dd')
  const filename = `plant-data_${fmt(startDate)}_to_${fmt(endDate)}.xlsx`

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

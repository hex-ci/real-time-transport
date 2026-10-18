/**
 * 群芳（7 号线）的官方时刻表夹具。
 *
 * 它不再是生产数据：`StationTimetableService` 默认空表，生产由
 * `subway_timetable_cache` 装载。这里只把适配层测试夹具转给服务端用例，
 * 让「精确 vs 推演」仍有真实样本；路径刻意只有这一处。
 */
export { STATION_TIMETABLES } from '@real-time-transport/transit-adapter/test-fixtures/station-timetables'

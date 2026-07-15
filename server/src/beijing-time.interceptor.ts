import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// 把响应中所有 Date 对象转成北京时间字符串（去掉Z后缀，前端不再偏移8小时）
function convertDates(obj: any): any {
  if (obj instanceof Date) {
    // DB存的就是北京时间，mysql2读成Date当成UTC了
    // 直接取toISOString()的值（=DB存的北京时间）去掉T/Z，前端不再偏移
    return obj.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (Array.isArray(obj)) return obj.map(convertDates);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const k of Object.keys(obj)) out[k] = convertDates(obj[k]);
    return out;
  }
  return obj;
}

@Injectable()
export class BeijingTimeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map(data => convertDates(data)));
  }
}
